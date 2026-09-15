use crate::runtime::{Host, Runtime};
use anyhow::{Result, bail};
use bytes::Bytes;
use http_body::{Body, Frame, SizeHint};
use http_body_util::{BodyExt, Full, Limited};
use hyper::{Request, Response, body::Incoming, server::conn::http1, service::service_fn};
use hyper_util::rt::TokioIo;
use std::{
    convert::Infallible,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};
use tokio::{
    net::TcpListener,
    sync::{OwnedSemaphorePermit, Semaphore},
    task::JoinSet,
};
use tokio_util::{
    sync::{CancellationToken, DropGuard},
    task::TaskTracker,
};
use wasmtime::{AsContextMut, component::Component};
use wasmtime_wasi_http::{
    WasiBody, WasiHttpView,
    handler::{Prepared, ProxyPre},
};

pub struct HttpServer {
    runtime: Arc<Runtime>,
    pre: ProxyPre<Host>,
    permits: Arc<Semaphore>,
    shutdown: CancellationToken,
    tasks: TaskTracker,
}

pub struct ResponseBody {
    inner: WasiBody,
    cancel: CancellationToken,
    _guard: Option<DropGuard>,
    _permit: Option<OwnedSemaphorePermit>,
}

impl Body for ResponseBody {
    type Data = Bytes;
    type Error = wasmtime_wasi_http::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        let result = Pin::new(&mut self.inner).poll_frame(cx);
        if matches!(result, Poll::Ready(None) | Poll::Ready(Some(Err(_)))) {
            self.cancel.cancel();
        }
        result
    }
    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }
    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

impl HttpServer {
    pub fn new(runtime: Arc<Runtime>, path: &std::path::Path) -> Result<Arc<Self>> {
        let span = runtime
            .telemetry
            .start("component.compile", None, 1, "compile");
        let result = Component::from_file(&runtime.engine, path);
        span.finish(if result.is_ok() { "ok" } else { "error" });
        let component = result?;
        Self::from_component(runtime, &component)
    }
    pub(crate) fn from_component(
        runtime: Arc<Runtime>,
        component: &Component,
    ) -> Result<Arc<Self>> {
        let pre = prepare_http(&runtime, component)?;
        let permits = Arc::new(Semaphore::new(runtime.config.max_concurrent_requests));
        Ok(Arc::new(Self {
            runtime,
            pre,
            permits,
            shutdown: CancellationToken::new(),
            tasks: TaskTracker::new(),
        }))
    }

    pub async fn serve(
        self: Arc<Self>,
        listener: TcpListener,
        shutdown: impl Future<Output = ()>,
    ) -> Result<()> {
        let _guard = self.shutdown.clone().drop_guard();
        tokio::pin!(shutdown);
        let mut connections = JoinSet::new();
        let result = loop {
            tokio::select! {
                _ = &mut shutdown => break Ok(()),
                Some(_) = connections.join_next(), if !connections.is_empty() => {},
                incoming = listener.accept() => {
                    let (socket, _) = match incoming { Ok(pair) => pair, Err(error) => break Err(error.into()) };
                    // Bound idle connections as well as active guest invocations.
                    if connections.len() >= (self.runtime.config.max_concurrent_requests * 2).max(32) { drop(socket); continue; }
                    let server = self.clone();
                    connections.spawn(async move {
                        let conn = http1::Builder::new().serve_connection(TokioIo::new(socket), service_fn(|request| {
                            let server = server.clone();
                            async move { Ok::<_, Infallible>(server.respond(request).await) }
                        }));
                        tokio::select! { _ = server.shutdown.cancelled() => {}, _ = conn => {} }
                    });
                }
            }
        };
        self.shutdown.cancel();
        while connections.join_next().await.is_some() {}
        self.tasks.close();
        self.tasks.wait().await;
        result
    }

    async fn respond(
        self: Arc<Self>,
        mut request: Request<Incoming>,
    ) -> Response<crate::telemetry::body::TrackedBody<ResponseBody>> {
        let method = request.method().to_string();
        let span = self
            .runtime
            .telemetry
            .request(request.headers_mut(), &method);
        let response = self.respond_inner(request).await;
        let status = response.status().as_u16();
        response.map(|body| crate::telemetry::body::TrackedBody::new(body, span, status))
    }

    async fn respond_inner(self: Arc<Self>, request: Request<Incoming>) -> Response<ResponseBody> {
        let limit = self.runtime.config.max_body_bytes;
        if request
            .body()
            .size_hint()
            .upper()
            .is_some_and(|n| n > limit as u64)
        {
            return error_response(413, "request body limit exceeded");
        }
        let permit = match self.permits.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                self.runtime.telemetry.reject();
                return error_response(503, "runtime at capacity");
            }
        };
        let cancel = self.shutdown.child_token();
        let guard = cancel.clone().drop_guard();
        let task_cancel = cancel.clone();
        let server = self.clone();
        let (tx, rx) = futures::channel::oneshot::channel();
        let request = request.map(|body| {
            Limited::new(body, limit)
                .map_err(move |_| {
                    wasmtime_wasi_http::Error::HttpRequestBodySize(Some(limit as u64))
                })
                .boxed_unsync()
        });
        self.tasks.spawn(async move {
            let run = async {
                let mut store = server.runtime.store(&[])?;
                let parent = crate::telemetry::TraceContext::from_headers(request.headers());
                let span = server.runtime.telemetry.start(
                    "component.instantiate",
                    parent.as_ref(),
                    1,
                    "instantiate",
                );
                let result = server.pre.instantiate_async(&mut store).await;
                span.finish(if result.is_ok() { "ok" } else { "error" });
                let proxy = result?;
                let execution =
                    server
                        .runtime
                        .telemetry
                        .start("http.handle", parent.as_ref(), 1, "run");
                let prepared =
                    match Prepared::new(store.as_context_mut(), &proxy, request, Host::http, tx) {
                        Ok(prepared) => prepared,
                        Err(error) => {
                            execution.finish("error");
                            return Err(error.into());
                        }
                    };
                store
                    .run_concurrent(async |accessor| {
                        let result = prepared.run(accessor, std::future::pending()).await;
                        execution.finish(if result.is_ok() { "ok" } else { "error" });
                        result?;
                        // A p3 handler may return before its response stream has finished.
                        task_cancel.cancelled().await;
                        Ok::<_, wasmtime::Error>(())
                    })
                    .await??;
                Ok::<_, anyhow::Error>(())
            };
            tokio::select! {
                _ = task_cancel.cancelled() => {},
                result = server.runtime.deadline(run) => {
                    if let Err(error) = result { eprintln!("guest execution failed: {error:#}"); }
                }
            }
        });
        let response = match self.runtime.deadline(async {
            tokio::select! {
                _ = cancel.cancelled() => bail!("request cancelled"),
                response = rx => Ok(response.map_err(|_| anyhow::anyhow!("guest stopped before producing a response"))??),
            }
        }).await {
            Ok(response) => response,
            Err(error) => {
                eprintln!("request failed: {error:#}");
                return error_response(500, "guest execution failed");
            }
        };
        response.map(|body| ResponseBody {
            inner: Limited::new(body, limit)
                .map_err(move |_| {
                    wasmtime_wasi_http::Error::HttpResponseBodySize(Some(limit as u64))
                })
                .boxed_unsync(),
            cancel,
            _guard: Some(guard),
            _permit: Some(permit),
        })
    }
}

pub(crate) fn prepare_http(runtime: &Runtime, component: &Component) -> Result<ProxyPre<Host>> {
    let pre = runtime.linker()?.instantiate_pre(component)?;
    match wasmtime_wasi_http::p3::bindings::ServicePre::new(pre.clone()) {
        Ok(pre) => Ok(ProxyPre::P3(pre)),
        Err(_) => Ok(ProxyPre::P2(
            wasmtime_wasi_http::p2::bindings::ProxyPre::new(pre)?,
        )),
    }
}

fn error_response(status: u16, message: &'static str) -> Response<ResponseBody> {
    Response::builder()
        .status(status)
        .body(ResponseBody {
            inner: Full::new(Bytes::from_static(message.as_bytes()))
                .map_err(|never| match never {})
                .boxed_unsync(),
            cancel: CancellationToken::new(),
            _guard: None,
            _permit: None,
        })
        .unwrap()
}
