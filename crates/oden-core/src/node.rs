//! Control-plane transport adapter for standard WASI HTTP components.
//! Each invocation owns a fresh Store; only validated component preparations are cached.
use crate::{
    config::RuntimeConfig,
    runtime::{Host, Runtime},
    server::prepare_http,
};
use anyhow::{Result, bail, ensure};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use wasmtime::component::Component;
use wasmtime::{AsContextMut, Config, Engine, InstanceAllocationStrategy, PoolingAllocationConfig};
use wasmtime_wasi_http::{
    WasiHttpView,
    handler::{Prepared, ProxyPre},
};

pub const WASI_PROFILE: &str = "wasip3";
pub struct CompileReport {
    pub wasi_profile: &'static str,
    pub component_path: String,
    pub precompiled_path: String,
    pub bytes: usize,
}

#[derive(Debug)]
pub struct HttpRequestInput {
    pub method: String,
    pub uri: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

#[derive(Debug)]
pub struct HttpResponseOutput {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Wasip3PoolingConfig {
    pub total_component_instances: u32,
    pub total_core_instances: u32,
    pub total_memories: u32,
    pub total_tables: u32,
    pub max_memory_size: usize,
    pub table_elements: usize,
    pub max_component_instance_size: usize,
    pub max_core_instance_size: usize,
}

impl Wasip3PoolingConfig {
    pub fn for_component_slots(slots: u32, memory_mb: u64) -> Self {
        let memory_bytes = memory_mb.saturating_mul(1024).saturating_mul(1024);
        Self {
            total_component_instances: slots,
            total_core_instances: slots.saturating_mul(4).max(slots),
            total_memories: slots,
            total_tables: slots.saturating_mul(2).max(slots),
            max_memory_size: usize::try_from(memory_bytes).unwrap_or(usize::MAX),
            table_elements: 20_000,
            max_component_instance_size: 1 << 20,
            max_core_instance_size: 1 << 20,
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct InvocationLimits {
    pub wall_ms: Option<u64>,
    pub cpu_ms: Option<u64>,
    pub memory_mb: Option<u64>,
    pub request_bytes: Option<usize>,
    pub response_bytes: Option<usize>,
    pub subrequests: Option<u32>,
}

#[derive(Debug, Clone, Default)]
pub struct HostPolicy {
    pub outbound_origins: Vec<String>,
}
impl HostPolicy {
    pub fn deny_all() -> Self {
        Self::default()
    }
    pub fn new(outbound_origins: Vec<String>) -> Result<Self> {
        RuntimeConfig {
            outbound_origins: outbound_origins.clone(),
            ..Default::default()
        }
        .validate()?;
        Ok(Self { outbound_origins })
    }
    pub fn allows_outbound_uri(&self, uri: &str) -> bool {
        reqwest::Url::parse(uri).is_ok_and(|url| {
            self.outbound_origins.iter().any(|origin| {
                reqwest::Url::parse(origin).is_ok_and(|allowed| allowed.origin() == url.origin())
            })
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Wasip3RuntimeOptions {
    pub max_prepared_components: usize,
    pub pooling: Option<Wasip3PoolingConfig>,
}
impl Default for Wasip3RuntimeOptions {
    fn default() -> Self {
        Self {
            max_prepared_components: 256,
            pooling: None,
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
enum Source {
    Component(PathBuf),
    Precompiled(PathBuf),
}
struct PreparedCache {
    max: usize,
    entries: VecDeque<(Source, Arc<ProxyPre<Host>>)>,
}
impl PreparedCache {
    fn get(&mut self, source: &Source) -> Option<Arc<ProxyPre<Host>>> {
        let index = self.entries.iter().position(|(key, _)| key == source)?;
        let entry = self.entries.remove(index)?;
        let pre = entry.1.clone();
        self.entries.push_back(entry);
        Some(pre)
    }
    fn insert(&mut self, source: Source, pre: Arc<ProxyPre<Host>>) {
        self.entries.retain(|(key, _)| *key != source);
        if self.max > 0 {
            while self.entries.len() >= self.max {
                self.entries.pop_front();
            }
            self.entries.push_back((source, pre));
        }
    }
}

pub struct Wasip3Runtime {
    runtime: Arc<Runtime>,
    prepared: Mutex<PreparedCache>,
}
impl Wasip3Runtime {
    pub fn new() -> Result<Self> {
        Self::with_options(Wasip3RuntimeOptions::default())
    }
    pub fn with_options(options: Wasip3RuntimeOptions) -> Result<Self> {
        Ok(Self {
            runtime: Runtime::with_engine(
                RuntimeConfig::default(),
                wasip3_engine_with_pooling(options.pooling.as_ref())?,
            )?,
            prepared: Mutex::new(PreparedCache {
                max: options.max_prepared_components,
                entries: VecDeque::new(),
            }),
        })
    }
    pub fn prepared_component_count(&self) -> usize {
        self.prepared.lock().unwrap().entries.len()
    }
    fn prepare(&self, source: Source) -> Result<Arc<ProxyPre<Host>>> {
        if let Some(pre) = self.prepared.lock().unwrap().get(&source) {
            return Ok(pre);
        }
        let component = match &source {
            Source::Component(path) => Component::from_file(&self.runtime.engine, path)?,
            // Only trusted node-local output from this compiler build is accepted here.
            // Deployment artifacts must always go through compile, never deserialize.
            Source::Precompiled(path) => unsafe {
                Component::deserialize_file(&self.runtime.engine, path)?
            },
        };
        let pre = Arc::new(prepare_http(&self.runtime, &component)?);
        self.prepared.lock().unwrap().insert(source, pre.clone());
        Ok(pre)
    }
    pub async fn invoke_component_handle_with_limits_and_policy_async(
        &self,
        path: &Path,
        request: HttpRequestInput,
        limits: InvocationLimits,
        policy: HostPolicy,
    ) -> Result<HttpResponseOutput> {
        self.invoke(Source::Component(path.into()), request, limits, policy)
            .await
    }
    pub async fn invoke_precompiled_component_handle_with_limits_and_policy_async(
        &self,
        path: &Path,
        request: HttpRequestInput,
        limits: InvocationLimits,
        policy: HostPolicy,
    ) -> Result<HttpResponseOutput> {
        self.invoke(Source::Precompiled(path.into()), request, limits, policy)
            .await
    }
    async fn invoke(
        &self,
        source: Source,
        input: HttpRequestInput,
        limits: InvocationLimits,
        policy: HostPolicy,
    ) -> Result<HttpResponseOutput> {
        let request_limit = limits.request_bytes.unwrap_or(1024 * 1024);
        let response_limit = limits.response_bytes.unwrap_or(1024 * 1024);
        ensure!(
            input.body.len() <= request_limit,
            "requestBytes limit exceeded"
        );
        let config = RuntimeConfig {
            memory_mb: usize::try_from(limits.memory_mb.unwrap_or(128))?,
            // WASI outbound bodies obey the stricter of the two route budgets.
            max_body_bytes: request_limit.min(response_limit),
            outbound_origins: policy.outbound_origins,
            ..Default::default()
        };
        config.validate()?;
        let mut request = hyper::Request::builder()
            .method(input.method.as_str())
            .uri(input.uri);
        for (name, value) in input.headers {
            request = request.header(name, value);
        }
        let request = request.body(
            Full::new(Bytes::from(input.body))
                .map_err(|never| match never {})
                .boxed_unsync(),
        )?;
        let pre = self.prepare(source)?;
        let (timeout, field) = match (limits.cpu_ms, limits.wall_ms) {
            (Some(cpu), Some(wall)) if cpu <= wall => (cpu, "cpuMs"),
            (_, Some(wall)) => (wall, "wallMs"),
            (Some(cpu), None) => (cpu, "cpuMs"),
            _ => (30_000, "wallMs"),
        };
        let run = async {
            let mut store =
                self.runtime
                    .store_with_config(&[], &config, limits.subrequests, false)?;
            let proxy = pre.instantiate_async(&mut store).await?;
            let (tx, rx) = futures::channel::oneshot::channel();
            let prepared = Prepared::new(store.as_context_mut(), &proxy, request, Host::http, tx)?;
            let execution = store.run_concurrent(async |accessor| {
                prepared.run(accessor, std::future::pending()).await?;
                // Keep servicing p3 body producers until the receiver is done.
                std::future::pending::<wasmtime::Result<()>>().await
            });
            let receive = async {
                let response = rx
                    .await
                    .map_err(|_| anyhow::anyhow!("guest stopped before response"))??;
                let (parts, body) = response.into_parts();
                let bytes = Limited::new(body, response_limit)
                    .collect()
                    .await
                    .map_err(|error| anyhow::anyhow!("responseBytes/body error: {error}"))?
                    .to_bytes();
                Ok::<_, anyhow::Error>(HttpResponseOutput {
                    status: parts.status.as_u16(),
                    headers: parts
                        .headers
                        .iter()
                        .map(|(name, value)| Ok((name.to_string(), value.to_str()?.to_owned())))
                        .collect::<Result<_>>()?,
                    body: bytes.to_vec(),
                })
            };
            tokio::pin!(receive);
            tokio::select! {
                result = &mut receive => result,
                result = execution => { result??; receive.await }
            }
        };
        tokio::time::timeout(Duration::from_millis(timeout), run)
            .await
            .map_err(|_| anyhow::anyhow!("{field} limit exceeded: {timeout}ms"))?
    }
}
pub fn wasip3_engine() -> Result<Engine> {
    wasip3_engine_with_pooling(None)
}

pub fn wasip3_engine_with_pooling(pooling: Option<&Wasip3PoolingConfig>) -> Result<Engine> {
    let mut config = Config::new();
    crate::engine::configure(&mut config);
    config.wasm_component_model(true);
    config.wasm_component_model_async(true);
    config.wasm_component_model_async_stackful(true);
    config.concurrency_support(true);
    config.epoch_interruption(true);
    if let Some(pooling) = pooling {
        config.memory_init_cow(true);
        config.memory_reservation(pooling.max_memory_size as u64);
        let mut pool = PoolingAllocationConfig::new();
        pool.total_component_instances(pooling.total_component_instances);
        pool.total_core_instances(pooling.total_core_instances);
        pool.total_memories(pooling.total_memories);
        pool.total_tables(pooling.total_tables);
        pool.max_memory_size(pooling.max_memory_size);
        pool.table_elements(pooling.table_elements);
        pool.max_component_instance_size(pooling.max_component_instance_size);
        pool.max_core_instance_size(pooling.max_core_instance_size);
        config.allocation_strategy(InstanceAllocationStrategy::Pooling(pool));
    }
    Ok(Engine::new(&config)?)
}

pub fn precompile_component_with_pooling(
    path: &Path,
    output: &Path,
    pooling: Option<&Wasip3PoolingConfig>,
) -> Result<CompileReport> {
    let runtime = Runtime::with_engine(
        RuntimeConfig::default(),
        wasip3_engine_with_pooling(pooling)?,
    )?;
    let component = Component::from_file(&runtime.engine, path)?;
    // Validate the standard HTTP contract and capabilities before publishing the cache entry.
    prepare_http(&runtime, &component)?;
    let bytes = component.serialize()?;
    std::fs::write(output, &bytes)?;
    Ok(CompileReport {
        wasi_profile: WASI_PROFILE,
        component_path: path.display().to_string(),
        precompiled_path: output.display().to_string(),
        bytes: bytes.len(),
    })
}
fn block_on<T>(future: impl Future<Output = Result<T>>) -> Result<T> {
    if tokio::runtime::Handle::try_current().is_ok() {
        bail!("use the async invocation API inside Tokio");
    }
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(future)
}
pub fn invoke_component_handle_with_limits_and_policy(
    path: &Path,
    request: HttpRequestInput,
    limits: InvocationLimits,
    policy: HostPolicy,
) -> Result<HttpResponseOutput> {
    let runtime = Wasip3Runtime::new()?;
    block_on(
        runtime.invoke_component_handle_with_limits_and_policy_async(path, request, limits, policy),
    )
}
pub fn invoke_precompiled_component_handle_with_limits_and_policy(
    path: &Path,
    request: HttpRequestInput,
    limits: InvocationLimits,
    policy: HostPolicy,
) -> Result<HttpResponseOutput> {
    let runtime = Wasip3Runtime::new()?;
    block_on(
        runtime.invoke_precompiled_component_handle_with_limits_and_policy_async(
            path, request, limits, policy,
        ),
    )
}
