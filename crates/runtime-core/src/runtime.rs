use crate::{
    config::RuntimeConfig,
    engine::{self, EpochTicker},
};
use anyhow::{Result, bail};
use http_body_util::BodyExt;
use std::{future::Future, path::Path, sync::Arc, time::Duration};
use wasmtime::component::{Component, Linker, ResourceTable};
use wasmtime::error::Context as _;
use wasmtime::{Config, Engine, Store, StoreLimits, StoreLimitsBuilder};
use wasmtime_wasi::{FsPerms, WasiCtx, WasiCtxView, WasiView};
use wasmtime_wasi_http::{
    RequestOptions, WasiBody, WasiHttpCtx, WasiHttpCtxView, WasiHttpHooks, WasiHttpView,
};

pub struct Runtime {
    pub(crate) engine: Engine,
    pub(crate) config: RuntimeConfig,
    _ticker: EpochTicker,
    durable: Arc<crate::durable::DurableClient>,
}

pub(crate) struct Host {
    wasi: WasiCtx,
    http: WasiHttpCtx,
    pub(crate) table: ResourceTable,
    pub(crate) durable: Arc<crate::durable::DurableClient>,
    limits: StoreLimits,
    hooks: HttpPolicy,
}

impl WasiView for Host {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}
impl wasmtime::component::HasData for Host {
    type Data<'a> = &'a mut Self;
}
impl WasiHttpView for Host {
    fn http(&mut self) -> WasiHttpCtxView<'_> {
        WasiHttpCtxView {
            ctx: &mut self.http,
            table: &mut self.table,
            hooks: &mut self.hooks,
        }
    }
}

struct HttpPolicy {
    origins: Vec<String>,
    body_limit: usize,
    remaining_requests: Option<u32>,
}
type IoResult = Box<dyn Future<Output = Result<(), wasmtime_wasi_http::Error>> + Send>;
impl WasiHttpHooks for HttpPolicy {
    fn send_request(
        &mut self,
        request: hyper::Request<WasiBody>,
        options: Option<RequestOptions>,
        _fut: IoResult,
    ) -> Box<
        dyn Future<Output = wasmtime_wasi_http::Result<(hyper::Response<WasiBody>, IoResult)>>
            + Send,
    > {
        let allowed = self.remaining_requests != Some(0)
            && reqwest::Url::parse(&request.uri().to_string())
                .ok()
                .is_some_and(|url| {
                    self.origins.iter().any(|origin| {
                        reqwest::Url::parse(origin).is_ok_and(|v| v.origin() == url.origin())
                    })
                });
        if let Some(remaining) = &mut self.remaining_requests {
            *remaining = remaining.saturating_sub(1);
        }
        let limit = self.body_limit;
        Box::new(async move {
            if !allowed {
                return Err(wasmtime_wasi_http::Error::HttpRequestDenied);
            }
            let request = request.map(|body| {
                http_body_util::Limited::new(body, limit)
                    .map_err(|e| wasmtime_wasi_http::Error::InternalError(Some(e.to_string())))
                    .boxed_unsync()
            });
            let (response, io) = wasmtime_wasi_http::default_send_request(request, options).await?;
            Ok((
                response.map(|body| {
                    http_body_util::Limited::new(body, limit)
                        .map_err(|e| wasmtime_wasi_http::Error::InternalError(Some(e.to_string())))
                        .boxed_unsync()
                }),
                Box::new(io) as IoResult,
            ))
        })
    }
}

impl Runtime {
    pub fn new(config: RuntimeConfig) -> Result<Arc<Self>> {
        config.validate()?;
        let mut engine_config = Config::new();
        engine_config
            .wasm_component_model(true)
            .wasm_component_model_async(true)
            .wasm_component_model_async_stackful(true)
            .concurrency_support(true)
            .epoch_interruption(true);
        engine::configure(&mut engine_config);
        let engine = Engine::new(&engine_config)?;
        Self::with_engine(config, engine)
    }

    pub(crate) fn with_engine(config: RuntimeConfig, engine: Engine) -> Result<Arc<Self>> {
        config.validate()?;
        let ticker = EpochTicker::new(engine.clone());
        let durable = Arc::new(crate::durable::DurableClient::new(
            config.durable.clone(),
            |name| std::env::var(name).ok(),
            config.timeout_ms,
            config.max_body_bytes.min(1024 * 1024),
            config.max_concurrent_requests,
        )?);
        Ok(Arc::new(Self {
            engine,
            config,
            _ticker: ticker,
            durable,
        }))
    }

    pub(crate) fn linker(&self) -> Result<Linker<Host>> {
        let mut linker = Linker::new(&self.engine);
        wasmtime_wasi::p2::add_to_linker_async(&mut linker)?;
        wasmtime_wasi::p3::add_to_linker(&mut linker)?;
        wasmtime_wasi_http::p2::add_only_http_to_linker_async(&mut linker)?;
        wasmtime_wasi_http::p3::add_to_linker(&mut linker)?;
        crate::durable::add_to_linker(&mut linker)?;
        Ok(linker)
    }

    pub(crate) fn store(&self, args: &[String]) -> Result<Store<Host>> {
        self.store_with_config(args, &self.config, None, true)
    }

    pub(crate) fn store_with_config(
        &self,
        args: &[String],
        config: &RuntimeConfig,
        subrequests: Option<u32>,
        inherit_stdio: bool,
    ) -> Result<Store<Host>> {
        config.validate()?;
        let mut wasi = WasiCtx::builder();
        wasi.args(args);
        if inherit_stdio {
            wasi.inherit_stdio();
        } else {
            wasi.inherit_stderr();
        }
        for (name, value) in &config.env {
            wasi.env(name, value);
        }
        for dir in &config.directories {
            let perms = if dir.write {
                FsPerms::ReadWrite
            } else {
                FsPerms::ReadOnly
            };
            wasi.preopened_dir(&dir.host, &dir.guest, perms)?;
        }
        let host = Host {
            wasi: wasi.build(),
            http: WasiHttpCtx::new(),
            table: ResourceTable::new(),
            durable: self.durable.clone(),
            limits: StoreLimitsBuilder::new()
                .memory_size(config.memory_mb * 1024 * 1024)
                .trap_on_grow_failure(true)
                .build(),
            hooks: HttpPolicy {
                origins: config.outbound_origins.clone(),
                body_limit: config.max_body_bytes,
                remaining_requests: subrequests,
            },
        };
        let mut store = Store::new(&self.engine, host);
        store.limiter(|host| &mut host.limits);
        // CPU-bound guests must yield too, so timeout and owner cancellation can
        // run even on a single Tokio thread. The enclosing future owns the deadline.
        store.epoch_deadline_callback(|_| {
            Ok(wasmtime::UpdateDeadline::YieldCustom(
                1,
                Box::pin(tokio::task::yield_now()),
            ))
        });
        store.set_epoch_deadline(1);
        Ok(store)
    }

    pub async fn run(&self, path: &Path, args: &[String]) -> Result<i32> {
        let component =
            Component::from_file(&self.engine, path).context("load command component")?;
        let linker = self.linker()?;
        let mut store = self.store(args)?;
        let result: Result<i32> = self
            .deadline(async {
                let instance = linker.instantiate_async(&mut store, &component).await?;
                if let Ok(command) =
                    wasmtime_wasi::p3::bindings::Command::new(&mut store, &instance)
                {
                    let result = store
                        .run_concurrent(async |accessor| {
                            command.wasi_cli_run().call_run(accessor).await
                        })
                        .await??;
                    Ok(if result.is_ok() { 0 } else { 1 })
                } else {
                    let command = wasmtime_wasi::p2::bindings::Command::new(&mut store, &instance)
                        .context("component must export wasi:cli/run@0.2 or @0.3")?;
                    Ok(
                        if command.wasi_cli_run().call_run(&mut store).await?.is_ok() {
                            0
                        } else {
                            1
                        },
                    )
                }
            })
            .await;
        match result {
            Err(error) if error.downcast_ref::<wasmtime_wasi::I32Exit>().is_some() => {
                Ok(error.downcast_ref::<wasmtime_wasi::I32Exit>().unwrap().0)
            }
            Err(error)
                if error.downcast_ref::<wasmtime::Trap>() == Some(&wasmtime::Trap::Interrupt) =>
            {
                bail!("execution deadline exceeded")
            }
            result => result,
        }
    }

    pub(crate) async fn deadline<T>(&self, future: impl Future<Output = Result<T>>) -> Result<T> {
        match tokio::time::timeout(Duration::from_millis(self.config.timeout_ms), future).await {
            Ok(result) => result,
            Err(_) => bail!("execution deadline exceeded"),
        }
    }
}
