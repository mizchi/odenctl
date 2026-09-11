//! A resident HTTP service: one instance, a bounded serial mailbox and async
//! background work driven continuously from start through graceful stop.
use crate::runtime::{Host, Runtime};
use anyhow::{Result, bail, ensure};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::{Request, Response, body::Incoming, server::conn::http1, service::service_fn};
use hyper_util::rt::TokioIo;
use serde::Deserialize;
use std::{convert::Infallible, path::Path, sync::Arc, time::Duration};
use tokio::{
    net::TcpListener,
    sync::{Semaphore, mpsc, oneshot},
    task::JoinSet,
    time::Instant,
};
use tokio_util::sync::CancellationToken;
use wasmtime::error::Context as _;
use wasmtime::{AsContextMut, component::Component};
use wasmtime_wasi_http::{
    WasiHttpView,
    handler::{Prepared, Proxy},
};

mod bindings {
    wasmtime::component::bindgen!({
        path: "../../wit/app", world: "lifecycle-hooks",
        exports: { default: async },
    });
}

#[derive(Clone, Debug, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ServiceOptions {
    pub startup_timeout_ms: u64,
    pub shutdown_timeout_ms: u64,
}
impl Default for ServiceOptions {
    fn default() -> Self {
        Self {
            startup_timeout_ms: 10_000,
            shutdown_timeout_ms: 10_000,
        }
    }
}
impl ServiceOptions {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            (1..=86_400_000).contains(&self.startup_timeout_ms),
            "invalid service startup timeout"
        );
        ensure!(
            (1..=86_400_000).contains(&self.shutdown_timeout_ms),
            "invalid service shutdown timeout"
        );
        Ok(())
    }
}

struct Call {
    request: Request<Bytes>,
    response: oneshot::Sender<Result<Response<Bytes>>>,
    deadline: Instant,
}

pub struct ResidentService {
    runtime: Arc<Runtime>,
    options: ServiceOptions,
    sender: mpsc::Sender<Call>,
    stop: CancellationToken,
    done: CancellationToken,
    worker: tokio::task::JoinHandle<Result<()>>,
}

impl ResidentService {
    pub async fn start(
        runtime: Arc<Runtime>,
        path: &Path,
        options: ServiceOptions,
    ) -> Result<Self> {
        options.validate()?;
        let component =
            Component::from_file(&runtime.engine, path).context("load resident service")?;
        let linker = runtime.linker()?;
        let pre = linker.instantiate_pre(&component)?;
        let mut store = runtime.store(&[])?;
        let startup_deadline = Instant::now() + Duration::from_millis(options.startup_timeout_ms);
        let instance = tokio::time::timeout_at(startup_deadline, pre.instantiate_async(&mut store))
            .await
            .context("service instantiation deadline exceeded")??;
        let hooks = bindings::LifecycleHooks::new(&mut store, &instance)
            .context("resident service must export wasmplane:app/lifecycle@0.1.0")?;
        let proxy = match wasmtime_wasi_http::p3::bindings::Service::new(&mut store, &instance) {
            Ok(service) => Proxy::P3(service),
            Err(_) => Proxy::P2(
                wasmtime_wasi_http::p2::bindings::Proxy::new(&mut store, &instance)
                    .context("resident service must export standard WASI HTTP")?,
            ),
        };
        let (sender, mut receiver) = mpsc::channel::<Call>(runtime.config.max_concurrent_requests);
        let (ready_tx, ready_rx) = oneshot::channel();
        let stop = CancellationToken::new();
        let done = CancellationToken::new();
        let worker_stop = stop.clone();
        let done_guard = done.clone().drop_guard();
        let worker_options = options.clone();
        let body_limit = runtime.config.max_body_bytes;
        let worker = tokio::spawn(async move {
            let _done = done_guard;
            // Wasmtime may hold the Store while running guest code, so a timer
            // inside run_concurrent cannot reliably interrupt a CPU loop.
            let (deadline_tx, mut deadline_rx) =
                tokio::sync::watch::channel(Some(startup_deadline));
            let failed = CancellationToken::new();
            let failure = failed.clone();
            let (failure_tx, mut failure_rx) = oneshot::channel();
            let execution = store.run_concurrent(async |accessor| {
                tokio::time::timeout_at(
                    startup_deadline,
                    hooks.wasmplane_app_lifecycle().call_start(accessor),
                )
                .await
                .context("service start deadline exceeded")??
                .map_err(|error| anyhow::anyhow!("service start: {error}"))?;
                let _ = ready_tx.send(());
                deadline_tx.send_replace(None);
                let mut draining = false;
                loop {
                    let call = tokio::select! {
                        biased;
                        _ = worker_stop.cancelled(), if !draining => {
                            receiver.close(); draining = true; continue;
                        }
                        call = receiver.recv() => match call { Some(call) => call, None => break },
                    };
                    if call.response.is_closed() {
                        continue;
                    }
                    // Expired queued calls never enter the guest. Once running,
                    // a deadline poisons this generation and the Store is dropped.
                    if Instant::now() >= call.deadline {
                        let _ = call
                            .response
                            .send(Err(anyhow::anyhow!("request expired in service queue")));
                        continue;
                    }
                    deadline_tx.send_replace(Some(call.deadline));
                    let run = async {
                        let request = call.request.map(|body| {
                            Full::new(body)
                                .map_err(|never| match never {})
                                .boxed_unsync()
                        });
                        let (tx, rx) = futures::channel::oneshot::channel();
                        let prepared = accessor.with(|mut store| {
                            Prepared::new(store.as_context_mut(), &proxy, request, Host::http, tx)
                        })?;
                        let handle = async {
                            prepared.run(accessor, std::future::pending()).await?;
                            Ok::<_, anyhow::Error>(())
                        };
                        let body = async {
                            let response =
                                rx.await.context("service stopped before responding")??;
                            let (parts, body) = response.into_parts();
                            let bytes = Limited::new(body, body_limit)
                                .collect()
                                .await
                                .map_err(|error| anyhow::anyhow!("response body: {error}"))?
                                .to_bytes();
                            Ok::<_, anyhow::Error>(Response::from_parts(parts, bytes))
                        };
                        let (_, response) = futures::try_join!(handle, body)?;
                        Ok::<_, anyhow::Error>(response)
                    };
                    match tokio::time::timeout_at(call.deadline, run).await {
                        Ok(Ok(response)) => {
                            deadline_tx.send_replace(None);
                            let _ = call.response.send(Ok(response));
                        }
                        result => {
                            let error = match result {
                                Ok(Err(error)) => error,
                                Err(_) => anyhow::anyhow!("service request deadline exceeded"),
                                Ok(Ok(_)) => unreachable!(),
                            };
                            let _ = call.response.send(Err(anyhow::anyhow!("{error:#}")));
                            let _ = failure_tx.send(error);
                            failure.cancel();
                            return Ok(());
                        }
                    }
                }
                deadline_tx.send_replace(Some(
                    Instant::now() + Duration::from_millis(worker_options.shutdown_timeout_ms),
                ));
                tokio::time::timeout(
                    Duration::from_millis(worker_options.shutdown_timeout_ms),
                    hooks.wasmplane_app_lifecycle().call_stop(accessor),
                )
                .await
                .context("service stop deadline exceeded")??
                .map_err(|error| anyhow::anyhow!("service stop: {error}"))?;
                Ok::<_, anyhow::Error>(())
            });
            tokio::pin!(execution);
            let mut watching = true;
            loop {
                let deadline = *deadline_rx.borrow_and_update();
                let timer = async {
                    match deadline {
                        Some(deadline) => tokio::time::sleep_until(deadline).await,
                        None => std::future::pending().await,
                    }
                };
                tokio::select! {
                    biased;
                    _ = failed.cancelled() => return Err(failure_rx.try_recv().unwrap_or_else(|_| anyhow::anyhow!("service failed"))),
                    _ = timer => bail!("service execution deadline exceeded"),
                    changed = deadline_rx.changed(), if watching => { watching = changed.is_ok(); },
                    result = &mut execution => { result??; break; }
                }
            }
            Ok(())
        });
        let mut service = Self {
            runtime,
            options,
            sender,
            stop,
            done,
            worker,
        };
        if ready_rx.await.is_err() {
            (&mut service.worker)
                .await
                .context("service worker failed")??;
            bail!("service stopped before readiness");
        }
        Ok(service)
    }

    pub async fn serve(
        mut self,
        listener: TcpListener,
        shutdown: impl Future<Output = ()>,
    ) -> Result<()> {
        let mut connections = JoinSet::new();
        let drain = CancellationToken::new();
        let force = CancellationToken::new();
        let permits = Arc::new(Semaphore::new(self.runtime.config.max_concurrent_requests));
        tokio::pin!(shutdown);
        let accept_result = loop {
            tokio::select! {
                _ = &mut shutdown => break Ok(()),
                _ = self.done.cancelled() => break Ok(()),
                Some(_) = connections.join_next(), if !connections.is_empty() => {},
                incoming = listener.accept() => {
                    let (socket, _) = match incoming { Ok(pair) => pair, Err(error) => break Err(error.into()) };
                    if connections.len() >= (self.runtime.config.max_concurrent_requests * 2).max(32) { drop(socket); continue; }
                    let sender = self.sender.clone();
                    let permits = permits.clone();
                    let runtime = self.runtime.clone();
                    let drain = drain.clone();
                    let force = force.clone();
                    connections.spawn(async move {
                        let connection = http1::Builder::new().serve_connection(TokioIo::new(socket), service_fn(|request| {
                            respond(request, sender.clone(), permits.clone(), runtime.clone(), drain.clone())
                        }));
                        tokio::pin!(connection);
                        tokio::select! {
                            _ = &mut connection => return,
                            _ = drain.cancelled() => connection.as_mut().graceful_shutdown(),
                        }
                        tokio::select! { _ = &mut connection => {}, _ = force.cancelled() => {} }
                    });
                }
            }
        };
        drop(listener);
        drain.cancel();
        let finish = async {
            while connections.join_next().await.is_some() {}
            // Body readers admitted before draining may still enqueue a call.
            // Close the mailbox only after these connections have completed.
            self.stop.cancel();
            (&mut self.worker).await.context("service worker failed")?
        };
        match tokio::time::timeout(
            Duration::from_millis(self.options.shutdown_timeout_ms),
            finish,
        )
        .await
        {
            Ok(result) => {
                result?;
                accept_result
            }
            Err(_) => {
                force.cancel();
                self.worker.abort();
                let _ = (&mut self.worker).await;
                while connections.join_next().await.is_some() {}
                bail!("service graceful shutdown deadline exceeded")
            }
        }
    }
}

impl Drop for ResidentService {
    fn drop(&mut self) {
        self.stop.cancel();
        self.worker.abort();
    }
}

async fn respond(
    request: Request<Incoming>,
    sender: mpsc::Sender<Call>,
    permits: Arc<Semaphore>,
    runtime: Arc<Runtime>,
    drain: CancellationToken,
) -> Result<Response<Full<Bytes>>, Infallible> {
    let error = |status, message: &'static str| {
        Response::builder()
            .status(status)
            .body(Full::new(Bytes::from_static(message.as_bytes())))
            .unwrap()
    };
    if drain.is_cancelled() {
        return Ok(error(503, "service is draining"));
    }
    let _permit = match permits.try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => return Ok(error(503, "service at capacity")),
    };
    let deadline = Instant::now() + Duration::from_millis(runtime.config.timeout_ms);
    let (parts, body) = request.into_parts();
    let bytes = match tokio::time::timeout_at(
        deadline,
        Limited::new(body, runtime.config.max_body_bytes).collect(),
    )
    .await
    {
        Ok(Ok(body)) => body.to_bytes(),
        Ok(Err(_)) => return Ok(error(413, "request body limit exceeded")),
        Err(_) => return Ok(error(408, "request body deadline exceeded")),
    };
    let (tx, rx) = oneshot::channel();
    if sender
        .send(Call {
            request: Request::from_parts(parts, bytes),
            response: tx,
            deadline,
        })
        .await
        .is_err()
    {
        return Ok(error(503, "service stopped"));
    }
    match tokio::time::timeout_at(deadline, rx).await {
        Ok(Ok(Ok(response))) => Ok(response.map(Full::new)),
        _ => Ok(error(500, "service request failed")),
    }
}
