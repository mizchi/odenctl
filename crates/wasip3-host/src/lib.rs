use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Result, anyhow, bail};
use native_tls::TlsConnector;
use wasmtime::component::{Component, HasData, Linker, Resource, ResourceTable, bindgen};
use wasmtime::{
    Config, Engine, InstanceAllocationStrategy, PoolingAllocationConfig, Store, StoreLimits,
    StoreLimitsBuilder,
};
use wasmtime_wasi::{WasiCtx, WasiCtxView, WasiView};

bindgen!({
    world: "worker",
    path: "../../wit/myedge-runtime.wit",
    imports: { default: async | trappable },
    exports: { default: async },
    with: {
        "myedge:runtime/http.incoming-body": IncomingBody,
        "myedge:runtime/http.outgoing-body": OutgoingBody,
        "myedge:runtime/kv.namespace": KvNamespace,
        "myedge:runtime/secrets.secret": Secret,
    },
});

pub const WASI_PROFILE: &str = "wasip3";
const EPOCH_TICK_MS: u64 = 10;

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

pub struct Wasip3Runtime {
    engine: Engine,
    prepared: Mutex<PreparedComponentCache>,
    max_reusable_instances_per_component: usize,
    instance_reuse_contract: InstanceReuseContract,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstanceReuseContract {
    Disabled,
    StatelessV1,
}

impl InstanceReuseContract {
    fn allows_idle_instance_reuse(self) -> bool {
        matches!(self, Self::StatelessV1)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Wasip3RuntimeOptions {
    pub max_prepared_components: usize,
    pub max_reusable_instances_per_component: usize,
    pub instance_reuse_contract: InstanceReuseContract,
    pub pooling: Option<Wasip3PoolingConfig>,
}

impl Default for Wasip3RuntimeOptions {
    fn default() -> Self {
        Self {
            max_prepared_components: 256,
            max_reusable_instances_per_component: 0,
            instance_reuse_contract: InstanceReuseContract::Disabled,
            pooling: None,
        }
    }
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

struct PreparedComponentCache {
    max: usize,
    entries: HashMap<PreparedComponentKey, PreparedComponentEntry>,
    lru: VecDeque<PreparedComponentKey>,
}

struct PreparedComponentEntry {
    worker_pre: WorkerPre<WorkerHost>,
    idle: Vec<ReusableWorkerInstance>,
}

struct ReusableWorkerInstance {
    store: Store<WorkerHost>,
    worker: Worker,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum PreparedComponentKey {
    Component(PathBuf),
    Precompiled(PathBuf),
}

pub struct IncomingBody {
    bytes: Vec<u8>,
    offset: usize,
}

pub struct OutgoingBody {
    chunks: Vec<Vec<u8>>,
    finished: bool,
}

pub struct KvNamespace {
    id: String,
}

pub struct Secret {
    id: String,
    value: Option<String>,
}

#[derive(Debug, Clone)]
struct KvValue {
    bytes: Vec<u8>,
    expires_at: Option<u64>,
}

#[derive(Debug)]
enum KvStore {
    Memory(HashMap<(String, String), KvValue>),
    File(FileKvStore),
}

#[derive(Debug)]
struct FileKvStore {
    root: PathBuf,
}

#[derive(Debug, Clone, Copy)]
pub struct InvocationLimits {
    pub wall_ms: Option<u64>,
    pub cpu_ms: Option<u64>,
    pub memory_mb: Option<u64>,
    pub request_bytes: Option<usize>,
    pub response_bytes: Option<usize>,
    pub subrequests: Option<u32>,
    pub host_calls: Option<u32>,
}

impl Default for InvocationLimits {
    fn default() -> Self {
        Self {
            wall_ms: None,
            cpu_ms: None,
            memory_mb: None,
            request_bytes: None,
            response_bytes: None,
            subrequests: None,
            host_calls: None,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct HostPolicy {
    outbound_http: OutboundHttpPolicy,
    kv_bindings: Vec<KvBindingPolicy>,
    secret_bindings: Vec<SecretBindingPolicy>,
}

#[derive(Debug, Clone, Default)]
pub struct OutboundHttpPolicy {
    enabled: bool,
    allow: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KvBindingPolicy {
    binding: String,
    namespace_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretBindingPolicy {
    binding: String,
    secret_id: String,
    value: Option<String>,
}

impl HostPolicy {
    pub fn deny_all() -> Self {
        Self::default()
    }

    pub fn new(outbound_http: OutboundHttpPolicy, kv_namespaces: Vec<String>) -> Self {
        let kv_bindings = kv_namespaces
            .into_iter()
            .map(|namespace| KvBindingPolicy::new(namespace.clone(), namespace))
            .collect();
        Self::with_bindings(outbound_http, kv_bindings, Vec::new())
    }

    pub fn with_bindings(
        outbound_http: OutboundHttpPolicy,
        kv_bindings: Vec<KvBindingPolicy>,
        secret_bindings: Vec<SecretBindingPolicy>,
    ) -> Self {
        Self {
            outbound_http,
            kv_bindings,
            secret_bindings,
        }
    }

    pub fn allows_kv_namespace(&self, namespace: &str) -> bool {
        self.kv_bindings
            .iter()
            .any(|item| item.namespace_id == namespace)
    }

    pub fn kv_namespace_for_binding(&self, binding: &str) -> Option<&str> {
        self.kv_bindings
            .iter()
            .find(|item| item.binding == binding)
            .map(|item| item.namespace_id.as_str())
    }

    pub fn allows_outbound_uri(&self, uri: &str) -> bool {
        self.outbound_http.allows(uri)
    }

    pub fn secret_for_binding(&self, binding: &str) -> Option<&SecretBindingPolicy> {
        self.secret_bindings
            .iter()
            .find(|item| item.binding == binding)
    }

    fn secret_values(&self) -> impl Iterator<Item = &str> {
        self.secret_bindings
            .iter()
            .filter_map(|item| item.value.as_deref())
    }
}

impl OutboundHttpPolicy {
    pub fn disabled() -> Self {
        Self::default()
    }

    pub fn enabled(allow: Vec<String>) -> Self {
        Self {
            enabled: true,
            allow,
        }
    }

    pub fn allows(&self, uri: &str) -> bool {
        if !self.enabled {
            return false;
        }
        let Ok(request) = parse_outbound_url(uri) else {
            return false;
        };
        self.allow.iter().any(|prefix| {
            parse_outbound_url(prefix)
                .map(|allowed| allowed.matches_request(&request))
                .unwrap_or(false)
        })
    }
}

impl KvBindingPolicy {
    pub fn new(binding: impl Into<String>, namespace_id: impl Into<String>) -> Self {
        Self {
            binding: binding.into(),
            namespace_id: namespace_id.into(),
        }
    }
}

impl SecretBindingPolicy {
    pub fn new(binding: impl Into<String>, secret_id: impl Into<String>) -> Self {
        Self {
            binding: binding.into(),
            secret_id: secret_id.into(),
            value: None,
        }
    }

    pub fn with_value(
        binding: impl Into<String>,
        secret_id: impl Into<String>,
        value: impl Into<String>,
    ) -> Self {
        Self {
            binding: binding.into(),
            secret_id: secret_id.into(),
            value: Some(value.into()),
        }
    }
}

impl KvStore {
    fn memory() -> Self {
        Self::Memory(HashMap::new())
    }

    fn file(root: impl Into<PathBuf>) -> Self {
        Self::File(FileKvStore { root: root.into() })
    }

    fn get(&mut self, namespace: &str, key: &str) -> Result<Option<Vec<u8>>> {
        match self {
            KvStore::Memory(items) => {
                let Some(value) = items.get(&(namespace.to_string(), key.to_string())) else {
                    return Ok(None);
                };
                if value_is_expired(value.expires_at) {
                    items.remove(&(namespace.to_string(), key.to_string()));
                    return Ok(None);
                }
                Ok(Some(value.bytes.clone()))
            }
            KvStore::File(store) => store.get(namespace, key),
        }
    }

    fn put(
        &mut self,
        namespace: &str,
        key: &str,
        value: Vec<u8>,
        ttl_seconds: Option<u64>,
    ) -> Result<()> {
        let expires_at = ttl_seconds.map(|ttl| unix_seconds().saturating_add(ttl));
        match self {
            KvStore::Memory(items) => {
                items.insert(
                    (namespace.to_string(), key.to_string()),
                    KvValue {
                        bytes: value,
                        expires_at,
                    },
                );
                Ok(())
            }
            KvStore::File(store) => store.put(namespace, key, value, expires_at),
        }
    }

    fn delete(&mut self, namespace: &str, key: &str) -> Result<()> {
        match self {
            KvStore::Memory(items) => {
                items.remove(&(namespace.to_string(), key.to_string()));
                Ok(())
            }
            KvStore::File(store) => store.delete(namespace, key),
        }
    }
}

impl FileKvStore {
    fn namespace_dir(&self, namespace: &str) -> PathBuf {
        self.root.join(hex_encode(namespace.as_bytes()))
    }

    fn key_path(&self, namespace: &str, key: &str) -> PathBuf {
        self.namespace_dir(namespace)
            .join(format!("{}.kv", hex_encode(key.as_bytes())))
    }

    fn get(&self, namespace: &str, key: &str) -> Result<Option<Vec<u8>>> {
        let path = self.key_path(namespace, key);
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let value = parse_kv_file(&text)?;
        if value_is_expired(value.expires_at) {
            let _ = fs::remove_file(path);
            return Ok(None);
        }
        Ok(Some(value.bytes))
    }

    fn put(
        &self,
        namespace: &str,
        key: &str,
        value: Vec<u8>,
        expires_at: Option<u64>,
    ) -> Result<()> {
        let dir = self.namespace_dir(namespace);
        fs::create_dir_all(&dir)?;
        let path = self.key_path(namespace, key);
        let tmp = path.with_extension(format!("tmp-{}-{}", std::process::id(), unix_seconds()));
        fs::write(
            &tmp,
            format_kv_file(&KvValue {
                bytes: value,
                expires_at,
            }),
        )?;
        fs::rename(tmp, path)?;
        Ok(())
    }

    fn delete(&self, namespace: &str, key: &str) -> Result<()> {
        match fs::remove_file(self.key_path(namespace, key)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
}

fn value_is_expired(expires_at: Option<u64>) -> bool {
    expires_at
        .map(|expires_at| expires_at <= unix_seconds())
        .unwrap_or(false)
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn format_kv_file(value: &KvValue) -> String {
    let expires_at = value
        .expires_at
        .map(|item| item.to_string())
        .unwrap_or_default();
    format!(
        "expires_at={expires_at}\nvalue={}\n",
        hex_encode(&value.bytes)
    )
}

fn parse_kv_file(text: &str) -> Result<KvValue> {
    let mut expires_at = None;
    let mut value = None;
    for line in text.lines() {
        if let Some(raw) = line.strip_prefix("expires_at=") {
            if !raw.is_empty() {
                expires_at = Some(raw.parse::<u64>()?);
            }
        } else if let Some(raw) = line.strip_prefix("value=") {
            value = Some(hex_decode(raw)?);
        }
    }
    let Some(bytes) = value else {
        bail!("kv value file is missing value");
    };
    Ok(KvValue { bytes, expires_at })
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn hex_decode(value: &str) -> Result<Vec<u8>> {
    if value.len() % 2 != 0 {
        bail!("hex value must have an even length");
    }
    let mut bytes = Vec::with_capacity(value.len() / 2);
    for index in (0..value.len()).step_by(2) {
        bytes.push(u8::from_str_radix(&value[index..index + 2], 16)?);
    }
    Ok(bytes)
}

pub struct WorkerHost {
    table: ResourceTable,
    wasi: WasiCtx,
    store_limits: StoreLimits,
    invocation_limits: InvocationLimits,
    policy: HostPolicy,
    subrequests: u32,
    host_calls: u32,
    kv: KvStore,
    logs: Vec<LogEvent>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogEvent {
    pub level: LogLevel,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LogLevel {
    Info,
    Warn,
    Error,
}

impl WorkerHost {
    pub fn new() -> Self {
        Self::with_limits_and_policy(InvocationLimits::default(), HostPolicy::deny_all())
    }

    pub fn with_limits_and_policy(limits: InvocationLimits, policy: HostPolicy) -> Self {
        Self::with_kv_store(limits, policy, KvStore::memory())
    }

    pub fn with_persistent_kv(
        limits: InvocationLimits,
        policy: HostPolicy,
        root: impl Into<PathBuf>,
    ) -> Self {
        Self::with_kv_store(limits, policy, KvStore::file(root))
    }

    fn with_kv_store(limits: InvocationLimits, policy: HostPolicy, kv: KvStore) -> Self {
        let mut store_limits = StoreLimitsBuilder::new();
        if let Some(memory_mb) = limits.memory_mb {
            let bytes = memory_mb.saturating_mul(1024).saturating_mul(1024);
            let bytes = usize::try_from(bytes).unwrap_or(usize::MAX);
            store_limits = store_limits.memory_size(bytes).trap_on_grow_failure(true);
        }
        Self {
            table: ResourceTable::new(),
            wasi: WasiCtx::builder().build(),
            store_limits: store_limits.build(),
            invocation_limits: limits,
            policy,
            subrequests: 0,
            host_calls: 0,
            kv,
            logs: Vec::new(),
        }
    }

    pub fn push_incoming_body(&mut self, bytes: Vec<u8>) -> Result<Resource<IncomingBody>> {
        Ok(self.table.push(IncomingBody { bytes, offset: 0 })?)
    }

    pub fn push_outgoing_body(&mut self) -> Result<Resource<OutgoingBody>> {
        Ok(self.table.push(OutgoingBody {
            chunks: Vec::new(),
            finished: false,
        })?)
    }

    pub fn push_namespace(&mut self, id: impl Into<String>) -> Result<Resource<KvNamespace>> {
        let id = id.into();
        if !self.policy.allows_kv_namespace(&id) {
            bail!("kv namespace {id} is not allowed by worker policy");
        }
        Ok(self.table.push(KvNamespace { id })?)
    }

    pub fn push_secret(
        &mut self,
        id: impl Into<String>,
        value: Option<String>,
    ) -> Result<Resource<Secret>> {
        Ok(self.table.push(Secret {
            id: id.into(),
            value,
        })?)
    }

    pub fn outgoing_body_bytes(&self, body: &Resource<OutgoingBody>) -> Result<Vec<u8>> {
        let body = self.table.get(body)?;
        Ok(body.chunks.concat())
    }

    pub fn is_outgoing_body_finished(&self, body: &Resource<OutgoingBody>) -> Result<bool> {
        Ok(self.table.get(body)?.finished)
    }

    pub fn logs(&self) -> &[LogEvent] {
        &self.logs
    }

    fn write_outgoing_chunk(
        &mut self,
        body: &Resource<OutgoingBody>,
        chunk: Vec<u8>,
    ) -> wasmtime::Result<()> {
        let body = self.table.get_mut(body)?;
        if body.finished {
            wasmtime::bail!("outgoing body already finished");
        }
        if let Some(limit) = self.invocation_limits.response_bytes {
            let current = body.chunks.iter().map(Vec::len).sum::<usize>();
            let next = current.saturating_add(chunk.len());
            if next > limit {
                wasmtime::bail!("responseBytes limit exceeded: {next} > {limit}");
            }
        }
        body.chunks.push(chunk);
        Ok(())
    }

    fn check_kv_allowed(&self, ns: &Resource<KvNamespace>) -> wasmtime::Result<String> {
        let namespace = self.table.get(ns)?.id.clone();
        if !self.policy.allows_kv_namespace(&namespace) {
            wasmtime::bail!("kv namespace {namespace} is not allowed by worker policy");
        }
        Ok(namespace)
    }

    fn kv_get(
        &mut self,
        ns: &Resource<KvNamespace>,
        key: String,
    ) -> wasmtime::Result<Option<Vec<u8>>> {
        self.check_host_call_allowed()?;
        let namespace = self.check_kv_allowed(ns)?;
        self.kv
            .get(&namespace, &key)
            .map_err(|error| wasmtime::Error::msg(error.to_string()))
    }

    fn kv_put(
        &mut self,
        ns: &Resource<KvNamespace>,
        key: String,
        value: Vec<u8>,
        ttl_seconds: Option<u64>,
    ) -> wasmtime::Result<()> {
        self.check_host_call_allowed()?;
        let namespace = self.check_kv_allowed(ns)?;
        self.kv
            .put(&namespace, &key, value, ttl_seconds)
            .map_err(|error| wasmtime::Error::msg(error.to_string()))
    }

    fn kv_delete(&mut self, ns: &Resource<KvNamespace>, key: String) -> wasmtime::Result<()> {
        self.check_host_call_allowed()?;
        let namespace = self.check_kv_allowed(ns)?;
        self.kv
            .delete(&namespace, &key)
            .map_err(|error| wasmtime::Error::msg(error.to_string()))
    }

    fn namespace_for_binding(
        &mut self,
        binding: String,
    ) -> wasmtime::Result<Option<Resource<KvNamespace>>> {
        self.check_host_call_allowed()?;
        let Some(namespace_id) = self
            .policy
            .kv_namespace_for_binding(&binding)
            .map(str::to_string)
        else {
            return Ok(None);
        };
        Ok(Some(self.table.push(KvNamespace { id: namespace_id })?))
    }

    fn secret_for_binding(
        &mut self,
        binding: String,
    ) -> wasmtime::Result<Option<Resource<Secret>>> {
        self.check_host_call_allowed()?;
        let Some(secret) = self.policy.secret_for_binding(&binding) else {
            return Ok(None);
        };
        Ok(Some(self.table.push(Secret {
            id: secret.secret_id.clone(),
            value: secret.value.clone(),
        })?))
    }

    fn reveal_secret(&mut self, secret: &Resource<Secret>) -> wasmtime::Result<String> {
        self.check_host_call_allowed()?;
        let secret = self.table.get(secret)?;
        let Some(value) = &secret.value else {
            wasmtime::bail!("secret {} value is not loaded", secret.id);
        };
        Ok(value.clone())
    }

    fn next_subrequest_allowed(&mut self) -> bool {
        self.subrequests = self.subrequests.saturating_add(1);
        self.invocation_limits
            .subrequests
            .map(|limit| self.subrequests <= limit)
            .unwrap_or(true)
    }

    fn check_host_call_allowed(&mut self) -> wasmtime::Result<()> {
        self.host_calls = self.host_calls.saturating_add(1);
        if let Some(limit) = self.invocation_limits.host_calls {
            if self.host_calls > limit {
                wasmtime::bail!("hostCalls limit exceeded: {} > {limit}", self.host_calls);
            }
        }
        Ok(())
    }

    fn redact_secrets(&self, message: String) -> String {
        self.policy
            .secret_values()
            .fold(message, |redacted, secret| {
                if secret.is_empty() {
                    redacted
                } else {
                    redacted.replace(secret, "[secret]")
                }
            })
    }

    fn fetch_outbound(
        &mut self,
        req: myedge::runtime::outbound::Request,
    ) -> wasmtime::Result<myedge::runtime::outbound::Response> {
        self.check_host_call_allowed()?;
        if !self.next_subrequest_allowed() {
            return Ok(outbound_text_response(429, "subrequests limit exceeded"));
        }
        if !self.policy.allows_outbound_uri(&req.uri) {
            return Ok(outbound_text_response(
                403,
                &format!("outbound fetch to {} is not allowed", req.uri),
            ));
        }
        match perform_http_fetch(req, &self.policy) {
            Ok(response) => Ok(response),
            Err(error) => Ok(outbound_text_response(
                502,
                &format!("outbound fetch failed: {error}"),
            )),
        }
    }
}

impl Default for WorkerHost {
    fn default() -> Self {
        Self::new()
    }
}

impl HasData for WorkerHost {
    type Data<'a> = &'a mut WorkerHost;
}

impl WasiView for WorkerHost {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

pub fn add_worker_imports(linker: &mut Linker<WorkerHost>) -> Result<()> {
    wasmtime_wasi::p2::add_to_linker_async(linker)?;
    Worker::add_to_linker::<WorkerHost, WorkerHost>(linker, |host| host)?;
    Ok(())
}

impl myedge::runtime::types::Host for WorkerHost {}
impl myedge::runtime::kv::Host for WorkerHost {
    async fn open_namespace(
        &mut self,
        binding: String,
    ) -> wasmtime::Result<Option<Resource<KvNamespace>>> {
        self.namespace_for_binding(binding)
    }
}
impl myedge::runtime::http::Host for WorkerHost {
    async fn new_outgoing_body(&mut self) -> wasmtime::Result<Resource<OutgoingBody>> {
        self.check_host_call_allowed()?;
        Ok(self.table.push(OutgoingBody {
            chunks: Vec::new(),
            finished: false,
        })?)
    }
}
impl myedge::runtime::outbound::Host for WorkerHost {}
impl myedge::runtime::secrets::Host for WorkerHost {
    async fn open_secret(&mut self, binding: String) -> wasmtime::Result<Option<Resource<Secret>>> {
        self.secret_for_binding(binding)
    }
}

impl myedge::runtime::kv::HostNamespace for WorkerHost {
    async fn drop(&mut self, rep: Resource<KvNamespace>) -> wasmtime::Result<()> {
        self.table.delete(rep)?;
        Ok(())
    }
}

impl myedge::runtime::secrets::HostSecret for WorkerHost {
    async fn drop(&mut self, rep: Resource<Secret>) -> wasmtime::Result<()> {
        self.table.delete(rep)?;
        Ok(())
    }
}

impl myedge::runtime::secrets::HostWithStore for WorkerHost {
    async fn reveal<T: Send>(
        accessor: &wasmtime::component::Accessor<T, Self>,
        secret: Resource<Secret>,
    ) -> wasmtime::Result<String> {
        accessor.with(|mut access| access.get().reveal_secret(&secret))
    }
}

impl myedge::runtime::kv::HostWithStore for WorkerHost {
    async fn get<T: Send>(
        accessor: &wasmtime::component::Accessor<T, Self>,
        ns: Resource<KvNamespace>,
        key: String,
    ) -> wasmtime::Result<Option<Vec<u8>>> {
        accessor.with(|mut access| access.get().kv_get(&ns, key))
    }

    async fn put<T: Send>(
        accessor: &wasmtime::component::Accessor<T, Self>,
        ns: Resource<KvNamespace>,
        key: String,
        value: Vec<u8>,
        ttl_seconds: Option<u64>,
    ) -> wasmtime::Result<()> {
        accessor.with(|mut access| access.get().kv_put(&ns, key, value, ttl_seconds))
    }

    async fn delete<T: Send>(
        accessor: &wasmtime::component::Accessor<T, Self>,
        ns: Resource<KvNamespace>,
        key: String,
    ) -> wasmtime::Result<()> {
        accessor.with(|mut access| access.get().kv_delete(&ns, key))
    }
}

impl myedge::runtime::http::HostIncomingBody for WorkerHost {
    async fn drop(&mut self, rep: Resource<IncomingBody>) -> wasmtime::Result<()> {
        self.table.delete(rep)?;
        Ok(())
    }
}

impl myedge::runtime::http::HostIncomingBodyWithStore for WorkerHost {
    async fn read<T: Send>(
        accessor: &wasmtime::component::Accessor<T, Self>,
        self_: Resource<IncomingBody>,
        max: u64,
    ) -> wasmtime::Result<Option<Vec<u8>>> {
        accessor.with(|mut access| {
            let host = access.get();
            host.check_host_call_allowed()?;
            let body = host.table.get_mut(&self_)?;
            if body.offset >= body.bytes.len() {
                return Ok(None);
            }
            let max = usize::try_from(max).unwrap_or(usize::MAX);
            let end = body.offset.saturating_add(max).min(body.bytes.len());
            let chunk = body.bytes[body.offset..end].to_vec();
            body.offset = end;
            Ok(Some(chunk))
        })
    }
}

impl myedge::runtime::http::HostOutgoingBody for WorkerHost {
    async fn drop(&mut self, rep: Resource<OutgoingBody>) -> wasmtime::Result<()> {
        self.table.delete(rep)?;
        Ok(())
    }
}

impl myedge::runtime::http::HostOutgoingBodyWithStore for WorkerHost {
    async fn write<T: Send>(
        accessor: &wasmtime::component::Accessor<T, Self>,
        self_: Resource<OutgoingBody>,
        chunk: Vec<u8>,
    ) -> wasmtime::Result<()> {
        accessor.with(|mut access| {
            let host = access.get();
            host.check_host_call_allowed()?;
            host.write_outgoing_chunk(&self_, chunk)?;
            Ok(())
        })
    }

    async fn finish<T: Send>(
        accessor: &wasmtime::component::Accessor<T, Self>,
        self_: Resource<OutgoingBody>,
    ) -> wasmtime::Result<()> {
        accessor.with(|mut access| {
            let host = access.get();
            host.check_host_call_allowed()?;
            let body = host.table.get_mut(&self_)?;
            body.finished = true;
            Ok(())
        })
    }
}

impl myedge::runtime::outbound::HostWithStore for WorkerHost {
    async fn fetch<T: Send>(
        accessor: &wasmtime::component::Accessor<T, Self>,
        req: myedge::runtime::outbound::Request,
    ) -> wasmtime::Result<myedge::runtime::outbound::Response> {
        accessor.with(|mut access| access.get().fetch_outbound(req))
    }
}

impl myedge::runtime::log::Host for WorkerHost {
    async fn info(&mut self, message: String) -> wasmtime::Result<()> {
        self.check_host_call_allowed()?;
        let message = self.redact_secrets(message);
        self.logs.push(LogEvent {
            level: LogLevel::Info,
            message,
        });
        Ok(())
    }

    async fn warn(&mut self, message: String) -> wasmtime::Result<()> {
        self.check_host_call_allowed()?;
        let message = self.redact_secrets(message);
        self.logs.push(LogEvent {
            level: LogLevel::Warn,
            message,
        });
        Ok(())
    }

    async fn error(&mut self, message: String) -> wasmtime::Result<()> {
        self.check_host_call_allowed()?;
        let message = self.redact_secrets(message);
        self.logs.push(LogEvent {
            level: LogLevel::Error,
            message,
        });
        Ok(())
    }
}

#[derive(Debug)]
struct OutboundUrlParts {
    scheme: String,
    host: String,
    port: u16,
    authority: String,
    target: String,
    path: String,
}

const MAX_OUTBOUND_REDIRECTS: usize = 5;

fn perform_http_fetch(
    req: myedge::runtime::outbound::Request,
    policy: &HostPolicy,
) -> Result<myedge::runtime::outbound::Response> {
    let connector = TlsConnector::new()?;
    perform_http_fetch_with_tls_connector(req, &connector, policy)
}

fn perform_http_fetch_with_tls_connector(
    mut req: myedge::runtime::outbound::Request,
    tls_connector: &TlsConnector,
    policy: &HostPolicy,
) -> Result<myedge::runtime::outbound::Response> {
    let mut url = parse_fetch_url(&req.uri)?;
    for redirects in 0..=MAX_OUTBOUND_REDIRECTS {
        let response = perform_single_http_fetch(&req, tls_connector)?;
        let Some(location) = redirect_location(&response) else {
            return Ok(response);
        };
        if redirects == MAX_OUTBOUND_REDIRECTS {
            bail!("outbound redirect limit exceeded");
        }
        let next_uri = validate_redirect_target(policy, &url, location)?;
        req = redirected_request(&req, next_uri);
        url = parse_fetch_url(&req.uri)?;
    }
    bail!("outbound redirect limit exceeded")
}

fn perform_single_http_fetch(
    req: &myedge::runtime::outbound::Request,
    tls_connector: &TlsConnector,
) -> Result<myedge::runtime::outbound::Response> {
    let url = parse_fetch_url(&req.uri)?;
    let upstream = resolve_outbound_address(&url)?;
    let stream = TcpStream::connect(upstream)?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;

    let request = build_http_request(&url, &req)?;
    match url.scheme.as_str() {
        "http" => send_http_request(stream, &request),
        "https" => {
            let stream = tls_connector.connect(&url.host, stream).map_err(|error| {
                anyhow::anyhow!("tls handshake failed for {}: {error}", url.host)
            })?;
            send_http_request(stream, &request)
        }
        _ => bail!("unsupported outbound URI scheme {}", url.scheme),
    }
}

fn redirect_location(response: &myedge::runtime::outbound::Response) -> Option<&str> {
    if !matches!(response.status, 301 | 302 | 303 | 307 | 308) {
        return None;
    }
    response
        .headers
        .iter()
        .find(|header| header.name.eq_ignore_ascii_case("location"))
        .map(|header| header.value.trim())
        .filter(|value| !value.is_empty())
}

fn validate_redirect_target(
    policy: &HostPolicy,
    current: &HttpUrlParts,
    location: &str,
) -> Result<String> {
    let next_uri = resolve_redirect_uri(current, location)?;
    let next = parse_fetch_url(&next_uri)?;
    if current.scheme == "https" && next.scheme == "http" {
        bail!("outbound redirect downgrade from https to http is not allowed");
    }
    if !policy.allows_outbound_uri(&next_uri) {
        bail!("outbound redirect to {next_uri} is not allowed");
    }
    Ok(next_uri)
}

fn redirected_request(
    request: &myedge::runtime::outbound::Request,
    uri: String,
) -> myedge::runtime::outbound::Request {
    myedge::runtime::outbound::Request {
        method: request.method.clone(),
        uri,
        headers: request.headers.clone(),
        body: request.body.clone(),
    }
}

fn resolve_redirect_uri(current: &HttpUrlParts, location: &str) -> Result<String> {
    let location = location.trim();
    if location.starts_with("http://") || location.starts_with("https://") {
        return Ok(location.to_string());
    }
    if let Some(rest) = location.strip_prefix("//") {
        return Ok(format!("{}://{rest}", current.scheme));
    }
    if location.starts_with('/') {
        return Ok(format!(
            "{}://{}{}",
            current.scheme, current.authority, location
        ));
    }
    if location.starts_with('?') {
        return Ok(format!(
            "{}://{}{}{}",
            current.scheme, current.authority, current.path, location
        ));
    }
    let base = current
        .path
        .rsplit_once('/')
        .map(|(prefix, _)| {
            if prefix.is_empty() {
                "/".to_string()
            } else {
                format!("{prefix}/")
            }
        })
        .unwrap_or_else(|| "/".to_string());
    Ok(format!(
        "{}://{}{}{}",
        current.scheme, current.authority, base, location
    ))
}

fn build_http_request(
    url: &HttpUrlParts,
    req: &myedge::runtime::outbound::Request,
) -> Result<Vec<u8>> {
    let method = normalize_http_method(&req.method)?;
    let mut request = Vec::new();
    write!(
        request,
        "{method} {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nContent-Length: {}\r\n",
        url.target,
        url.authority,
        req.body.len()
    )?;
    for header in &req.headers {
        if is_forwardable_request_header(&header.name) {
            write!(request, "{}: {}\r\n", header.name, header.value)?;
        }
    }
    request.extend_from_slice(b"\r\n");
    request.extend_from_slice(&req.body);
    Ok(request)
}

fn send_http_request(
    mut stream: impl Read + Write,
    request: &[u8],
) -> Result<myedge::runtime::outbound::Response> {
    stream.write_all(&request)?;

    let mut response = Vec::new();
    stream.read_to_end(&mut response)?;
    parse_http_response(&response)
}

fn resolve_outbound_address(url: &HttpUrlParts) -> Result<SocketAddr> {
    let addresses = (url.host.as_str(), url.port).to_socket_addrs()?;
    addresses
        .filter(|address| outbound_address_allowed_for_host(&url.host, address.ip()))
        .next()
        .ok_or_else(|| {
            anyhow::anyhow!(
                "outbound host {} did not resolve to an allowed public address",
                url.host
            )
        })
}

fn parse_fetch_url(uri: &str) -> Result<HttpUrlParts> {
    let url = parse_outbound_url(uri)?;
    if url.scheme != "http" && url.scheme != "https" {
        bail!("only http:// and https:// outbound fetch are supported");
    }
    Ok(url)
}

type HttpUrlParts = OutboundUrlParts;

impl OutboundUrlParts {
    fn matches_request(&self, request: &OutboundUrlParts) -> bool {
        self.scheme == request.scheme
            && self.host == request.host
            && self.port == request.port
            && path_prefix_matches(&self.path, &request.path)
    }
}

fn parse_outbound_url(uri: &str) -> Result<OutboundUrlParts> {
    if uri.contains('#') {
        bail!("outbound URI fragments are not supported");
    }
    let (scheme, rest) = match uri.split_once("://") {
        Some((scheme, rest)) if scheme == "http" || scheme == "https" => (scheme, rest),
        _ => bail!("outbound URI must be http:// or https://"),
    };
    let (authority, target) = split_authority_and_target(rest)?;
    if authority.is_empty()
        || authority.contains('@')
        || authority.contains('[')
        || authority.contains(']')
    {
        bail!("invalid outbound URI authority");
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port))
            if !host.is_empty() && port.chars().all(|item| item.is_ascii_digit()) =>
        {
            (host.to_ascii_lowercase(), port.parse::<u16>()?)
        }
        Some(_) => bail!("invalid outbound URI port"),
        _ => (
            authority.to_ascii_lowercase(),
            default_port_for_scheme(scheme),
        ),
    };
    let path = target
        .split_once('?')
        .map(|(path, _)| path.to_string())
        .unwrap_or_else(|| target.clone());
    Ok(OutboundUrlParts {
        scheme: scheme.to_string(),
        host,
        port,
        authority: authority.to_string(),
        target,
        path,
    })
}

fn split_authority_and_target(rest: &str) -> Result<(&str, String)> {
    let split = rest.find(['/', '?']);
    let Some(index) = split else {
        return Ok((rest, "/".to_string()));
    };
    let authority = &rest[..index];
    let suffix = &rest[index..];
    if suffix.starts_with('/') {
        Ok((authority, suffix.to_string()))
    } else if suffix.starts_with('?') {
        Ok((authority, format!("/{suffix}")))
    } else {
        bail!("invalid outbound URI target");
    }
}

fn default_port_for_scheme(scheme: &str) -> u16 {
    match scheme {
        "https" => 443,
        _ => 80,
    }
}

fn path_prefix_matches(allowed: &str, request: &str) -> bool {
    if allowed == "/" || request == allowed {
        return true;
    }
    if allowed.ends_with('/') {
        return request.starts_with(allowed);
    }
    request
        .strip_prefix(allowed)
        .map(|rest| rest.starts_with('/'))
        .unwrap_or(false)
}

fn outbound_address_allowed_for_host(host: &str, address: IpAddr) -> bool {
    if host.parse::<IpAddr>().is_ok() {
        return true;
    }
    !is_private_or_local_address(address)
}

fn is_private_or_local_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let octets = address.octets();
            octets[0] == 0
                || octets[0] == 10
                || octets[0] == 127
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
                || (octets[0] == 169 && octets[1] == 254)
                || (octets[0] == 172 && (16..=31).contains(&octets[1]))
                || (octets[0] == 192 && octets[1] == 168)
                || (octets[0] == 198 && (18..=19).contains(&octets[1]))
                || octets[0] >= 224
        }
        IpAddr::V6(address) => {
            let segments = address.segments();
            address.is_loopback()
                || address.is_unspecified()
                || (segments[0] & 0xfe00) == 0xfc00
                || (segments[0] & 0xffc0) == 0xfe80
                || (segments[0] & 0xff00) == 0xff00
        }
    }
}

fn normalize_http_method(method: &str) -> Result<&str> {
    match method {
        "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" => Ok(method),
        _ => bail!("unsupported outbound method {method}"),
    }
}

fn is_forwardable_request_header(name: &str) -> bool {
    !matches!(
        name.to_ascii_lowercase().as_str(),
        "host" | "connection" | "content-length" | "transfer-encoding"
    )
}

fn parse_http_response(bytes: &[u8]) -> Result<myedge::runtime::outbound::Response> {
    let Some(header_end) = find_header_end(bytes) else {
        bail!("upstream response missing headers");
    };
    let header_text = std::str::from_utf8(&bytes[..header_end])?;
    let mut lines = header_text.split("\r\n");
    let status_line = lines.next().unwrap_or_default();
    let status = parse_status(status_line)?;
    let mut headers = Vec::new();
    let mut chunked = false;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim().to_string();
        let value = value.trim().to_string();
        if name.eq_ignore_ascii_case("transfer-encoding")
            && value.to_ascii_lowercase().contains("chunked")
        {
            chunked = true;
        }
        if is_safe_outbound_response_header(&name) {
            headers.push(myedge::runtime::types::Header { name, value });
        }
    }
    let raw_body = &bytes[header_end + 4..];
    let body = if chunked {
        decode_chunked_body(raw_body)?
    } else {
        raw_body.to_vec()
    };
    Ok(myedge::runtime::outbound::Response {
        status,
        headers,
        body,
    })
}

fn parse_status(status_line: &str) -> Result<u16> {
    let mut parts = status_line.split_whitespace();
    let version = parts.next().unwrap_or_default();
    if !version.starts_with("HTTP/") {
        bail!("upstream response has invalid status line");
    }
    let status = parts
        .next()
        .ok_or_else(|| anyhow::anyhow!("upstream response missing status"))?
        .parse::<u16>()?;
    Ok(status)
}

fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

fn decode_chunked_body(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut body = Vec::new();
    let mut offset = 0;
    loop {
        let Some(line_end) = find_crlf(&bytes[offset..]) else {
            bail!("invalid chunked response");
        };
        let size_text = std::str::from_utf8(&bytes[offset..offset + line_end])?;
        let size = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16)?;
        offset += line_end + 2;
        if size == 0 {
            return Ok(body);
        }
        if offset + size + 2 > bytes.len() {
            bail!("truncated chunked response");
        }
        body.extend_from_slice(&bytes[offset..offset + size]);
        offset += size + 2;
    }
}

fn find_crlf(bytes: &[u8]) -> Option<usize> {
    bytes.windows(2).position(|window| window == b"\r\n")
}

fn is_safe_outbound_response_header(name: &str) -> bool {
    !matches!(
        name.to_ascii_lowercase().as_str(),
        "connection" | "transfer-encoding"
    )
}

fn outbound_text_response(status: u16, message: &str) -> myedge::runtime::outbound::Response {
    myedge::runtime::outbound::Response {
        status,
        headers: vec![myedge::runtime::types::Header {
            name: "content-type".to_string(),
            value: "text/plain".to_string(),
        }],
        body: message.as_bytes().to_vec(),
    }
}

pub fn wasip3_engine() -> Result<Engine> {
    wasip3_engine_with_pooling(None)
}

pub fn wasip3_engine_with_pooling(pooling: Option<&Wasip3PoolingConfig>) -> Result<Engine> {
    let mut config = Config::new();
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

impl Wasip3Runtime {
    pub fn new() -> Result<Self> {
        Self::with_options(Wasip3RuntimeOptions::default())
    }

    pub fn with_options(options: Wasip3RuntimeOptions) -> Result<Self> {
        let engine = wasip3_engine_with_pooling(options.pooling.as_ref())?;
        start_epoch_ticker(engine.clone());
        Ok(Self {
            engine,
            prepared: Mutex::new(PreparedComponentCache::new(options.max_prepared_components)),
            max_reusable_instances_per_component: options.max_reusable_instances_per_component,
            instance_reuse_contract: options.instance_reuse_contract,
        })
    }

    pub fn invoke_component_handle_with_limits_and_policy(
        &self,
        component_path: &Path,
        request: HttpRequestInput,
        limits: InvocationLimits,
        policy: HostPolicy,
    ) -> Result<HttpResponseOutput> {
        self.invoke_component_handle_with_host(
            PreparedComponentKey::Component(component_path.to_path_buf()),
            request,
            WorkerHost::with_limits_and_policy(limits, policy),
        )
    }

    pub fn invoke_component_handle_with_persistent_kv(
        &self,
        component_path: &Path,
        request: HttpRequestInput,
        limits: InvocationLimits,
        policy: HostPolicy,
        kv_store_dir: &Path,
    ) -> Result<HttpResponseOutput> {
        self.invoke_component_handle_with_host(
            PreparedComponentKey::Component(component_path.to_path_buf()),
            request,
            WorkerHost::with_persistent_kv(limits, policy, kv_store_dir),
        )
    }

    pub fn invoke_precompiled_component_handle_with_limits_and_policy(
        &self,
        precompiled_path: &Path,
        request: HttpRequestInput,
        limits: InvocationLimits,
        policy: HostPolicy,
    ) -> Result<HttpResponseOutput> {
        self.invoke_component_handle_with_host(
            PreparedComponentKey::Precompiled(precompiled_path.to_path_buf()),
            request,
            WorkerHost::with_limits_and_policy(limits, policy),
        )
    }

    pub fn invoke_precompiled_component_handle_with_persistent_kv(
        &self,
        precompiled_path: &Path,
        request: HttpRequestInput,
        limits: InvocationLimits,
        policy: HostPolicy,
        kv_store_dir: &Path,
    ) -> Result<HttpResponseOutput> {
        self.invoke_component_handle_with_host(
            PreparedComponentKey::Precompiled(precompiled_path.to_path_buf()),
            request,
            WorkerHost::with_persistent_kv(limits, policy, kv_store_dir),
        )
    }

    pub fn prepared_component_count(&self) -> usize {
        self.prepared
            .lock()
            .expect("prepared component cache poisoned")
            .len()
    }

    pub fn reusable_instance_count(&self) -> usize {
        self.prepared
            .lock()
            .expect("prepared component cache poisoned")
            .reusable_len()
    }

    fn invoke_component_handle_with_host(
        &self,
        component_key: PreparedComponentKey,
        request: HttpRequestInput,
        host: WorkerHost,
    ) -> Result<HttpResponseOutput> {
        let limits = host.invocation_limits;
        enforce_request_body_limit(&request, limits)?;
        let worker_pre = self.prepare_worker(component_key.clone())?;
        if self.instance_reuse_enabled() {
            if let Some(mut reusable) = self.take_reusable_worker(&component_key) {
                *reusable.store.data_mut() = host;
                return self.invoke_reusable_worker(component_key, reusable, request, limits);
            }
        }

        let mut store = Store::new(&self.engine, host);
        store.limiter(|host| &mut host.store_limits);
        let epoch_deadline = configure_ticker_epoch_deadline(&mut store, limits);
        let worker = futures::executor::block_on(worker_pre.instantiate_async(&mut store))
            .map_err(|error| map_epoch_deadline_error(error, epoch_deadline))?;
        self.invoke_reusable_worker(
            component_key,
            ReusableWorkerInstance { store, worker },
            request,
            limits,
        )
    }

    fn prepare_worker(&self, component_key: PreparedComponentKey) -> Result<WorkerPre<WorkerHost>> {
        {
            let mut cache = self
                .prepared
                .lock()
                .expect("prepared component cache poisoned");
            if let Some(prepared) = cache.get(&component_key) {
                return Ok(prepared);
            }
        }

        let component = match &component_key {
            PreparedComponentKey::Component(component_path) => {
                Component::from_file(&self.engine, component_path)?
            }
            PreparedComponentKey::Precompiled(precompiled_path) => {
                // Safety: wasmplane only writes these serialized artifacts from the same host binary
                // and treats them as trusted node-local cache entries, not portable user artifacts.
                unsafe { Component::deserialize_file(&self.engine, precompiled_path)? }
            }
        };
        let mut linker = Linker::<WorkerHost>::new(&self.engine);
        add_worker_imports(&mut linker)?;
        let prepared = WorkerPre::new(linker.instantiate_pre(&component)?)?;

        let mut cache = self
            .prepared
            .lock()
            .expect("prepared component cache poisoned");
        Ok(cache.insert(component_key, prepared))
    }

    fn take_reusable_worker(
        &self,
        component_key: &PreparedComponentKey,
    ) -> Option<ReusableWorkerInstance> {
        self.prepared
            .lock()
            .expect("prepared component cache poisoned")
            .take_reusable(component_key)
    }

    fn return_reusable_worker(
        &self,
        component_key: PreparedComponentKey,
        reusable: ReusableWorkerInstance,
    ) {
        self.prepared
            .lock()
            .expect("prepared component cache poisoned")
            .return_reusable(
                component_key,
                reusable,
                self.max_reusable_instances_per_component,
            );
    }

    fn instance_reuse_enabled(&self) -> bool {
        self.max_reusable_instances_per_component > 0
            && self.instance_reuse_contract.allows_idle_instance_reuse()
    }

    fn invoke_reusable_worker(
        &self,
        component_key: PreparedComponentKey,
        mut reusable: ReusableWorkerInstance,
        request: HttpRequestInput,
        limits: InvocationLimits,
    ) -> Result<HttpResponseOutput> {
        let response =
            invoke_prepared_worker(&mut reusable.store, &reusable.worker, request, limits)?;
        if self.instance_reuse_enabled() {
            *reusable.store.data_mut() = WorkerHost::new();
            self.return_reusable_worker(component_key, reusable);
        }
        Ok(response)
    }
}

fn invoke_prepared_worker(
    store: &mut Store<WorkerHost>,
    worker: &Worker,
    request: HttpRequestInput,
    limits: InvocationLimits,
) -> Result<HttpResponseOutput> {
    let epoch_deadline = configure_ticker_epoch_deadline(store, limits);
    let response = futures::executor::block_on(async {
        store
            .run_concurrent(async |accessor| -> wasmtime::Result<_> {
                let body = accessor.with(|mut access| {
                    access.get().table.push(IncomingBody {
                        bytes: request.body,
                        offset: 0,
                    })
                })?;
                let request = Request {
                    head: myedge::runtime::types::RequestHead {
                        method: request.method,
                        uri: request.uri,
                        headers: request
                            .headers
                            .into_iter()
                            .map(|(name, value)| myedge::runtime::types::Header { name, value })
                            .collect(),
                    },
                    body,
                };
                worker.call_handle(accessor, request).await
            })
            .await?
    })
    .map_err(|error| map_epoch_deadline_error(error, epoch_deadline))?;

    let response_body = store.data().outgoing_body_bytes(&response.body)?;
    Ok(HttpResponseOutput {
        status: response.head.status,
        headers: response
            .head
            .headers
            .into_iter()
            .map(|header| (header.name, header.value))
            .collect(),
        body: response_body,
    })
}

impl PreparedComponentCache {
    fn new(max: usize) -> Self {
        Self {
            max: max.max(1),
            entries: HashMap::new(),
            lru: VecDeque::new(),
        }
    }

    fn len(&self) -> usize {
        self.entries.len()
    }

    fn reusable_len(&self) -> usize {
        self.entries.values().map(|entry| entry.idle.len()).sum()
    }

    fn get(&mut self, key: &PreparedComponentKey) -> Option<WorkerPre<WorkerHost>> {
        let prepared = self.entries.get(key)?.worker_pre.clone();
        self.touch(key);
        Some(prepared)
    }

    fn insert(
        &mut self,
        key: PreparedComponentKey,
        prepared: WorkerPre<WorkerHost>,
    ) -> WorkerPre<WorkerHost> {
        self.entries.insert(
            key.clone(),
            PreparedComponentEntry {
                worker_pre: prepared.clone(),
                idle: Vec::new(),
            },
        );
        self.touch(&key);
        while self.entries.len() > self.max {
            let Some(evicted) = self.lru.pop_front() else {
                break;
            };
            self.entries.remove(&evicted);
        }
        prepared
    }

    fn take_reusable(&mut self, key: &PreparedComponentKey) -> Option<ReusableWorkerInstance> {
        let reusable = self.entries.get_mut(key)?.idle.pop()?;
        self.touch(key);
        Some(reusable)
    }

    fn return_reusable(
        &mut self,
        key: PreparedComponentKey,
        reusable: ReusableWorkerInstance,
        max_reusable_instances_per_component: usize,
    ) {
        if max_reusable_instances_per_component == 0 {
            return;
        }
        let Some(entry) = self.entries.get_mut(&key) else {
            return;
        };
        if entry.idle.len() < max_reusable_instances_per_component {
            entry.idle.push(reusable);
            self.touch(&key);
        }
    }

    fn touch(&mut self, key: &PreparedComponentKey) {
        self.lru.retain(|existing| existing != key);
        self.lru.push_back(key.clone());
    }
}

#[cfg(target_has_atomic = "64")]
fn start_epoch_ticker(engine: Engine) {
    thread::spawn(move || {
        loop {
            thread::sleep(Duration::from_millis(EPOCH_TICK_MS));
            engine.increment_epoch();
        }
    });
}

#[cfg(not(target_has_atomic = "64"))]
fn start_epoch_ticker(_engine: Engine) {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EpochDeadline {
    CpuMs(u64),
    WallMs(u64),
}

impl EpochDeadline {
    fn ms(self) -> u64 {
        match self {
            Self::CpuMs(ms) | Self::WallMs(ms) => ms,
        }
    }

    fn field(self) -> &'static str {
        match self {
            Self::CpuMs(_) => "cpuMs",
            Self::WallMs(_) => "wallMs",
        }
    }
}

fn epoch_deadline_for_limits(limits: InvocationLimits) -> Option<EpochDeadline> {
    match (limits.cpu_ms, limits.wall_ms) {
        (Some(cpu_ms), Some(wall_ms)) if cpu_ms <= wall_ms => Some(EpochDeadline::CpuMs(cpu_ms)),
        (Some(_), Some(wall_ms)) => Some(EpochDeadline::WallMs(wall_ms)),
        (Some(cpu_ms), None) => Some(EpochDeadline::CpuMs(cpu_ms)),
        (None, Some(wall_ms)) => Some(EpochDeadline::WallMs(wall_ms)),
        (None, None) => None,
    }
}

fn epoch_deadline_ticks(deadline: EpochDeadline) -> u64 {
    deadline.ms().div_ceil(EPOCH_TICK_MS).max(1)
}

fn map_epoch_deadline_error(
    error: wasmtime::Error,
    deadline: Option<EpochDeadline>,
) -> anyhow::Error {
    if let Some(deadline) = deadline {
        let message = format!("{error:#}");
        if is_epoch_deadline_error(&message) {
            return anyhow!(
                "{} limit exceeded after {}ms",
                deadline.field(),
                deadline.ms()
            );
        }
    }
    anyhow!("{error:#}")
}

fn is_epoch_deadline_error(message: &str) -> bool {
    message.contains("epoch") || message.contains("interrupt") || message.contains("deadline")
}

fn configure_ticker_epoch_deadline(
    store: &mut Store<WorkerHost>,
    limits: InvocationLimits,
) -> Option<EpochDeadline> {
    #[cfg(target_has_atomic = "64")]
    {
        let deadline = epoch_deadline_for_limits(limits);
        store.epoch_deadline_trap();
        let ticks = deadline.map(epoch_deadline_ticks).unwrap_or(u64::MAX / 2);
        store.set_epoch_deadline(ticks);
        deadline
    }
    #[cfg(not(target_has_atomic = "64"))]
    {
        let _ = store;
        let _ = limits;
        None
    }
}

fn configure_single_invocation_epoch_deadline(
    engine: &Engine,
    store: &mut Store<WorkerHost>,
    limits: InvocationLimits,
) -> Option<EpochDeadline> {
    #[cfg(target_has_atomic = "64")]
    {
        let deadline = epoch_deadline_for_limits(limits);
        if let Some(deadline) = deadline {
            store.epoch_deadline_trap();
            store.set_epoch_deadline(1);
            let engine = engine.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(deadline.ms()));
                engine.increment_epoch();
            });
        }
        deadline
    }
    #[cfg(not(target_has_atomic = "64"))]
    {
        let _ = engine;
        let _ = store;
        let _ = limits;
        None
    }
}

pub fn precompile_component(component_path: &Path, output_path: &Path) -> Result<CompileReport> {
    precompile_component_with_pooling(component_path, output_path, None)
}

pub fn precompile_component_with_pooling(
    component_path: &Path,
    output_path: &Path,
    pooling: Option<&Wasip3PoolingConfig>,
) -> Result<CompileReport> {
    let engine = wasip3_engine_with_pooling(pooling)?;
    let component = Component::from_file(&engine, component_path)?;
    let bytes = component.serialize()?;
    std::fs::write(output_path, &bytes)?;
    Ok(CompileReport {
        wasi_profile: WASI_PROFILE,
        component_path: component_path.display().to_string(),
        precompiled_path: output_path.display().to_string(),
        bytes: bytes.len(),
    })
}

pub fn invoke_component_handle(
    component_path: &Path,
    request: HttpRequestInput,
) -> Result<HttpResponseOutput> {
    invoke_component_handle_with_limits_and_policy(
        component_path,
        request,
        InvocationLimits::default(),
        HostPolicy::deny_all(),
    )
}

pub fn invoke_component_handle_with_limits_and_policy(
    component_path: &Path,
    request: HttpRequestInput,
    limits: InvocationLimits,
    policy: HostPolicy,
) -> Result<HttpResponseOutput> {
    invoke_component_handle_with_host(
        ComponentSource::Component(component_path),
        request,
        WorkerHost::with_limits_and_policy(limits, policy),
    )
}

pub fn invoke_component_handle_with_persistent_kv(
    component_path: &Path,
    request: HttpRequestInput,
    limits: InvocationLimits,
    policy: HostPolicy,
    kv_store_dir: &Path,
) -> Result<HttpResponseOutput> {
    invoke_component_handle_with_host(
        ComponentSource::Component(component_path),
        request,
        WorkerHost::with_persistent_kv(limits, policy, kv_store_dir),
    )
}

pub fn invoke_precompiled_component_handle_with_limits_and_policy(
    precompiled_path: &Path,
    request: HttpRequestInput,
    limits: InvocationLimits,
    policy: HostPolicy,
) -> Result<HttpResponseOutput> {
    invoke_component_handle_with_host(
        ComponentSource::Precompiled(precompiled_path),
        request,
        WorkerHost::with_limits_and_policy(limits, policy),
    )
}

pub fn invoke_precompiled_component_handle_with_persistent_kv(
    precompiled_path: &Path,
    request: HttpRequestInput,
    limits: InvocationLimits,
    policy: HostPolicy,
    kv_store_dir: &Path,
) -> Result<HttpResponseOutput> {
    invoke_component_handle_with_host(
        ComponentSource::Precompiled(precompiled_path),
        request,
        WorkerHost::with_persistent_kv(limits, policy, kv_store_dir),
    )
}

enum ComponentSource<'a> {
    Component(&'a Path),
    Precompiled(&'a Path),
}

fn invoke_component_handle_with_host(
    component_source: ComponentSource<'_>,
    request: HttpRequestInput,
    host: WorkerHost,
) -> Result<HttpResponseOutput> {
    let limits = host.invocation_limits;
    enforce_request_body_limit(&request, limits)?;
    let engine = wasip3_engine()?;
    let component = match component_source {
        ComponentSource::Component(component_path) => {
            Component::from_file(&engine, component_path)?
        }
        ComponentSource::Precompiled(precompiled_path) => {
            // Safety: wasmplane only writes these serialized artifacts from the same host binary
            // and treats them as trusted node-local cache entries, not portable user artifacts.
            unsafe { Component::deserialize_file(&engine, precompiled_path)? }
        }
    };
    let mut linker = Linker::<WorkerHost>::new(&engine);
    add_worker_imports(&mut linker)?;
    let mut store = Store::new(&engine, host);
    store.limiter(|host| &mut host.store_limits);
    let epoch_deadline = configure_single_invocation_epoch_deadline(&engine, &mut store, limits);
    let worker =
        futures::executor::block_on(Worker::instantiate_async(&mut store, &component, &linker))
            .map_err(|error| map_epoch_deadline_error(error, epoch_deadline))?;

    let response = futures::executor::block_on(async {
        store
            .run_concurrent(async |accessor| -> wasmtime::Result<_> {
                let body = accessor.with(|mut access| {
                    access.get().table.push(IncomingBody {
                        bytes: request.body,
                        offset: 0,
                    })
                })?;
                let request = Request {
                    head: myedge::runtime::types::RequestHead {
                        method: request.method,
                        uri: request.uri,
                        headers: request
                            .headers
                            .into_iter()
                            .map(|(name, value)| myedge::runtime::types::Header { name, value })
                            .collect(),
                    },
                    body,
                };
                worker.call_handle(accessor, request).await
            })
            .await?
    })
    .map_err(|error| map_epoch_deadline_error(error, epoch_deadline))?;

    let response_body = store.data().outgoing_body_bytes(&response.body)?;
    Ok(HttpResponseOutput {
        status: response.head.status,
        headers: response
            .head
            .headers
            .into_iter()
            .map(|header| (header.name, header.value))
            .collect(),
        body: response_body,
    })
}

fn enforce_request_body_limit(request: &HttpRequestInput, limits: InvocationLimits) -> Result<()> {
    if let Some(limit) = limits.request_bytes {
        let actual = request.body.len();
        if actual > limit {
            bail!("requestBytes limit exceeded: {actual} > {limit}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::process::Command;

    use native_tls::{Identity, TlsAcceptor, TlsConnector};

    use super::*;

    #[test]
    fn engine_enables_wasip3_component_async_features() {
        let engine = wasip3_engine().expect("engine");
        Component::new(&engine, "(component)").expect("empty component compiles");
    }

    #[test]
    fn epoch_deadline_prefers_cpu_budget_over_larger_wall_budget() {
        let deadline = epoch_deadline_for_limits(InvocationLimits {
            cpu_ms: Some(50),
            wall_ms: Some(1000),
            ..InvocationLimits::default()
        });

        assert_eq!(deadline, Some(EpochDeadline::CpuMs(50)));
    }

    #[test]
    fn epoch_deadline_keeps_wall_budget_when_smaller_than_cpu_budget() {
        let deadline = epoch_deadline_for_limits(InvocationLimits {
            cpu_ms: Some(500),
            wall_ms: Some(100),
            ..InvocationLimits::default()
        });

        assert_eq!(deadline, Some(EpochDeadline::WallMs(100)));
    }

    #[test]
    fn engine_accepts_pooling_allocator_config() {
        let pooling = Wasip3PoolingConfig::for_component_slots(4, 64);
        let engine = wasip3_engine_with_pooling(Some(&pooling)).expect("pooling engine");

        Component::new(&engine, "(component)").expect("empty component compiles");
    }

    #[test]
    fn runtime_limits_prepared_component_cache_with_lru_eviction() {
        let dir = temp_dir("runtime-cache-lru");
        let component_path = build_async_worker_component(&dir);
        let second_component_path = dir.join("worker-copy.component.wasm");
        std::fs::copy(&component_path, &second_component_path).expect("copy component");
        let runtime = Wasip3Runtime::with_options(Wasip3RuntimeOptions {
            max_prepared_components: 1,
            max_reusable_instances_per_component: 0,
            instance_reuse_contract: InstanceReuseContract::Disabled,
            pooling: None,
        })
        .expect("runtime");

        let _ = runtime.invoke_component_handle_with_limits_and_policy(
            &component_path,
            hello_request(),
            InvocationLimits::default(),
            HostPolicy::deny_all(),
        );
        assert_eq!(runtime.prepared_component_count(), 1);

        let _ = runtime.invoke_component_handle_with_limits_and_policy(
            &second_component_path,
            hello_request(),
            InvocationLimits::default(),
            HostPolicy::deny_all(),
        );
        assert_eq!(runtime.prepared_component_count(), 1);
    }

    #[test]
    fn runtime_instantiates_components_with_pooling_allocator() {
        let dir = temp_dir("runtime-pooling");
        let component_path = build_async_worker_component(&dir);
        let runtime = Wasip3Runtime::with_options(Wasip3RuntimeOptions {
            max_prepared_components: 4,
            max_reusable_instances_per_component: 0,
            instance_reuse_contract: InstanceReuseContract::Disabled,
            pooling: Some(Wasip3PoolingConfig::for_component_slots(4, 64)),
        })
        .expect("runtime");

        let _ = runtime.invoke_component_handle_with_limits_and_policy(
            &component_path,
            hello_request(),
            InvocationLimits::default(),
            HostPolicy::deny_all(),
        );

        assert_eq!(runtime.prepared_component_count(), 1);
    }

    #[test]
    fn runtime_drops_reusable_instance_after_guest_trap() {
        let dir = temp_dir("runtime-reuse-trap");
        let component_path = build_async_worker_component(&dir);
        let runtime = Wasip3Runtime::with_options(Wasip3RuntimeOptions {
            max_prepared_components: 4,
            max_reusable_instances_per_component: 1,
            instance_reuse_contract: InstanceReuseContract::StatelessV1,
            pooling: None,
        })
        .expect("runtime");

        let error = runtime
            .invoke_component_handle_with_limits_and_policy(
                &component_path,
                hello_request(),
                InvocationLimits::default(),
                HostPolicy::deny_all(),
            )
            .expect_err("dummy component should trap");

        assert!(format!("{error:?}").contains("wasm trap"));
        assert_eq!(runtime.prepared_component_count(), 1);
        assert_eq!(runtime.reusable_instance_count(), 0);
    }

    #[test]
    fn runtime_requires_explicit_contract_before_instance_reuse() {
        let without_contract = Wasip3Runtime::with_options(Wasip3RuntimeOptions {
            max_prepared_components: 4,
            max_reusable_instances_per_component: 1,
            instance_reuse_contract: InstanceReuseContract::Disabled,
            pooling: None,
        })
        .expect("runtime");
        let with_contract = Wasip3Runtime::with_options(Wasip3RuntimeOptions {
            max_prepared_components: 4,
            max_reusable_instances_per_component: 1,
            instance_reuse_contract: InstanceReuseContract::StatelessV1,
            pooling: None,
        })
        .expect("runtime");

        assert!(!without_contract.instance_reuse_enabled());
        assert!(with_contract.instance_reuse_enabled());
    }

    #[test]
    fn precompile_component_serializes_component_artifact() {
        let dir = std::env::temp_dir().join(format!("wasmplane-host-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("tmp dir");
        let component_path = dir.join("empty.component.wat");
        let precompiled_path = dir.join("empty.component.cwasm");
        std::fs::write(&component_path, "(component)").expect("write component");

        let report = precompile_component(&component_path, &precompiled_path).expect("precompile");

        assert_eq!(report.wasi_profile, "wasip3");
        assert_eq!(PathBuf::from(report.component_path), component_path);
        assert_eq!(PathBuf::from(report.precompiled_path), precompiled_path);
        assert!(report.bytes > 0);
        assert!(std::fs::metadata(precompiled_path).expect("metadata").len() > 0);
    }

    #[test]
    fn add_worker_imports_registers_custom_wit_interfaces() {
        let engine = wasip3_engine().expect("engine");
        let mut linker = Linker::<WorkerHost>::new(&engine);

        add_worker_imports(&mut linker).expect("imports");
    }

    #[test]
    fn instantiate_async_worker_component_with_host_imports() {
        let dir = temp_dir("instantiate-worker");
        let component_path = build_async_worker_component(&dir);
        let engine = wasip3_engine().expect("engine");
        let component = Component::from_file(&engine, component_path).expect("component");
        let mut linker = Linker::<WorkerHost>::new(&engine);
        add_worker_imports(&mut linker).expect("imports");
        let mut store = Store::new(&engine, WorkerHost::new());
        #[cfg(target_has_atomic = "64")]
        store.set_epoch_deadline(1);

        futures::executor::block_on(Worker::instantiate_async(&mut store, &component, &linker))
            .expect("instantiate");
    }

    fn hello_request() -> HttpRequestInput {
        HttpRequestInput {
            method: "GET".to_string(),
            uri: "https://hello.example.dev/".to_string(),
            headers: Vec::new(),
            body: Vec::new(),
        }
    }

    #[test]
    fn invoke_component_handle_reaches_guest_export_and_reports_guest_traps() {
        let dir = temp_dir("call-worker");
        let component_path = build_async_worker_component(&dir);

        let error = invoke_component_handle(
            &component_path,
            HttpRequestInput {
                method: "GET".to_string(),
                uri: "https://hello.example.dev/".to_string(),
                headers: Vec::new(),
                body: b"hello".to_vec(),
            },
        )
        .expect_err("dummy component should trap in its generated handle body");

        assert!(format!("{error:?}").contains("wasm trap"));
    }

    #[test]
    fn invoke_precompiled_component_handle_reaches_guest_export() {
        let dir = temp_dir("call-precompiled-worker");
        let component_path = build_async_worker_component(&dir);
        let precompiled_path = dir.join("worker.component.cwasm");
        precompile_component(&component_path, &precompiled_path).expect("precompile component");

        let error = invoke_precompiled_component_handle_with_limits_and_policy(
            &precompiled_path,
            HttpRequestInput {
                method: "GET".to_string(),
                uri: "https://hello.example.dev/".to_string(),
                headers: Vec::new(),
                body: b"hello".to_vec(),
            },
            InvocationLimits::default(),
            HostPolicy::deny_all(),
        )
        .expect_err("dummy precompiled component should trap in its generated handle body");

        assert!(format!("{error:?}").contains("wasm trap"));
    }

    #[test]
    fn host_body_resources_are_readable_and_writable() {
        let mut host = WorkerHost::new();
        let incoming = host
            .push_incoming_body(b"abcdef".to_vec())
            .expect("incoming");
        let outgoing = host.push_outgoing_body().expect("outgoing");

        let first = {
            let body = host.table.get_mut(&incoming).expect("incoming body");
            let end = body.offset + 3;
            let chunk = body.bytes[body.offset..end].to_vec();
            body.offset = end;
            chunk
        };
        host.table
            .get_mut(&outgoing)
            .expect("outgoing body")
            .chunks
            .push(first);
        host.table
            .get_mut(&outgoing)
            .expect("outgoing body")
            .finished = true;

        assert_eq!(host.outgoing_body_bytes(&outgoing).expect("bytes"), b"abc");
        assert!(host.is_outgoing_body_finished(&outgoing).expect("finished"));
    }

    #[test]
    fn host_policy_denies_unbound_kv_namespaces() {
        let mut host =
            WorkerHost::with_limits_and_policy(InvocationLimits::default(), HostPolicy::deny_all());

        let error = host
            .push_namespace("kv_main")
            .expect_err("unbound kv namespace should be denied");

        assert!(format!("{error:?}").contains("kv namespace kv_main is not allowed"));
    }

    #[test]
    fn host_policy_allows_bound_kv_namespaces() {
        let mut host = WorkerHost::with_limits_and_policy(
            InvocationLimits::default(),
            HostPolicy::new(OutboundHttpPolicy::disabled(), vec!["kv_main".to_string()]),
        );

        let namespace = host
            .push_namespace("kv_main")
            .expect("bound namespace should be allowed");

        assert_eq!(
            host.check_kv_allowed(&namespace).expect("namespace id"),
            "kv_main"
        );
    }

    #[test]
    fn host_policy_resolves_kv_bindings_to_namespace_handles() {
        let mut host = WorkerHost::with_limits_and_policy(
            InvocationLimits::default(),
            HostPolicy::with_bindings(
                OutboundHttpPolicy::disabled(),
                vec![KvBindingPolicy::new("MAIN", "tenant_a/main")],
                Vec::new(),
            ),
        );

        let namespace = host
            .namespace_for_binding("MAIN".to_string())
            .expect("binding lookup")
            .expect("namespace handle");

        assert_eq!(
            host.check_kv_allowed(&namespace).expect("namespace id"),
            "tenant_a/main"
        );
        assert!(
            host.namespace_for_binding("OTHER".to_string())
                .expect("unknown binding")
                .is_none()
        );
    }

    #[test]
    fn persistent_kv_store_survives_host_instances_and_deletes_values() {
        let dir = temp_dir("persistent-kv");
        let policy = HostPolicy::with_bindings(
            OutboundHttpPolicy::disabled(),
            vec![KvBindingPolicy::new("MAIN", "tenant_a/main")],
            Vec::new(),
        );
        let mut writer = WorkerHost::with_persistent_kv(
            InvocationLimits::default(),
            policy.clone(),
            dir.clone(),
        );
        let namespace = writer
            .namespace_for_binding("MAIN".to_string())
            .expect("binding lookup")
            .expect("namespace handle");

        writer
            .kv_put(&namespace, "greeting".to_string(), b"hello".to_vec(), None)
            .expect("put kv");

        let mut reader = WorkerHost::with_persistent_kv(
            InvocationLimits::default(),
            policy.clone(),
            dir.clone(),
        );
        let namespace = reader
            .namespace_for_binding("MAIN".to_string())
            .expect("binding lookup")
            .expect("namespace handle");

        assert_eq!(
            reader
                .kv_get(&namespace, "greeting".to_string())
                .expect("get kv"),
            Some(b"hello".to_vec())
        );

        reader
            .kv_delete(&namespace, "greeting".to_string())
            .expect("delete kv");
        let mut after_delete = WorkerHost::with_persistent_kv(
            InvocationLimits::default(),
            policy.clone(),
            dir.clone(),
        );
        let namespace = after_delete
            .namespace_for_binding("MAIN".to_string())
            .expect("binding lookup")
            .expect("namespace handle");

        assert_eq!(
            after_delete
                .kv_get(&namespace, "greeting".to_string())
                .expect("get deleted kv"),
            None
        );
    }

    #[test]
    fn persistent_kv_store_expires_ttl_values() {
        let dir = temp_dir("persistent-kv-ttl");
        let policy = HostPolicy::with_bindings(
            OutboundHttpPolicy::disabled(),
            vec![KvBindingPolicy::new("MAIN", "tenant_a/main")],
            Vec::new(),
        );
        let mut host = WorkerHost::with_persistent_kv(
            InvocationLimits::default(),
            policy.clone(),
            dir.clone(),
        );
        let namespace = host
            .namespace_for_binding("MAIN".to_string())
            .expect("binding lookup")
            .expect("namespace handle");

        host.kv_put(
            &namespace,
            "ephemeral".to_string(),
            b"value".to_vec(),
            Some(0),
        )
        .expect("put ttl kv");

        let mut reader = WorkerHost::with_persistent_kv(
            InvocationLimits::default(),
            policy.clone(),
            dir.clone(),
        );
        let namespace = reader
            .namespace_for_binding("MAIN".to_string())
            .expect("binding lookup")
            .expect("namespace handle");

        assert_eq!(
            reader
                .kv_get(&namespace, "ephemeral".to_string())
                .expect("get expired kv"),
            None
        );
    }

    #[test]
    fn host_policy_resolves_secret_bindings_and_redacts_revealed_values_from_logs() {
        let mut host = WorkerHost::with_limits_and_policy(
            InvocationLimits::default(),
            HostPolicy::with_bindings(
                OutboundHttpPolicy::disabled(),
                Vec::new(),
                vec![SecretBindingPolicy::with_value(
                    "API_KEY",
                    "sec_api_key",
                    "super-secret",
                )],
            ),
        );
        let secret = host
            .secret_for_binding("API_KEY".to_string())
            .expect("binding lookup")
            .expect("secret handle");

        assert_eq!(
            host.reveal_secret(&secret).expect("secret value"),
            "super-secret"
        );
        futures::executor::block_on(myedge::runtime::log::Host::info(
            &mut host,
            "token=super-secret".to_string(),
        ))
        .expect("log write");

        assert_eq!(host.logs()[0].message, "token=[secret]");
    }

    #[test]
    fn secret_reveal_fails_when_value_is_not_loaded() {
        let mut host = WorkerHost::with_limits_and_policy(
            InvocationLimits::default(),
            HostPolicy::with_bindings(
                OutboundHttpPolicy::disabled(),
                Vec::new(),
                vec![SecretBindingPolicy::new("API_KEY", "sec_api_key")],
            ),
        );
        let secret = host
            .secret_for_binding("API_KEY".to_string())
            .expect("binding lookup")
            .expect("secret handle");

        let error = host
            .reveal_secret(&secret)
            .expect_err("unloaded secret should not reveal");

        assert!(format!("{error:?}").contains("value is not loaded"));
    }

    #[test]
    fn outgoing_body_write_enforces_response_byte_limit() {
        let mut host = WorkerHost::with_limits_and_policy(
            InvocationLimits {
                response_bytes: Some(3),
                ..InvocationLimits::default()
            },
            HostPolicy::deny_all(),
        );
        let outgoing = host.push_outgoing_body().expect("outgoing body");

        host.write_outgoing_chunk(&outgoing, b"abc".to_vec())
            .expect("within limit");
        let error = host
            .write_outgoing_chunk(&outgoing, b"d".to_vec())
            .expect_err("response byte limit should be enforced");

        assert!(format!("{error:?}").contains("responseBytes limit exceeded"));
    }

    #[test]
    fn host_policy_allows_only_configured_outbound_prefixes() {
        let policy = HostPolicy::new(
            OutboundHttpPolicy::enabled(vec!["https://api.example.dev/v1/".to_string()]),
            Vec::new(),
        );

        assert!(policy.allows_outbound_uri("https://api.example.dev/v1/users"));
        assert!(!policy.allows_outbound_uri("https://api.example.dev/v2/users"));
        assert!(!HostPolicy::deny_all().allows_outbound_uri("https://api.example.dev/v1/users"));
    }

    #[test]
    fn host_policy_matches_outbound_allowlist_by_url_origin_and_path() {
        let policy = HostPolicy::new(
            OutboundHttpPolicy::enabled(vec![
                "https://api.example.dev/v1/".to_string(),
                "http://127.0.0.1:8080/".to_string(),
            ]),
            Vec::new(),
        );

        assert!(policy.allows_outbound_uri("https://API.EXAMPLE.DEV:443/v1/users"));
        assert!(policy.allows_outbound_uri("http://127.0.0.1:8080/probe"));
        assert!(!policy.allows_outbound_uri("https://api.example.dev.evil/v1/users"));
        assert!(!policy.allows_outbound_uri("https://api.example.dev/v10/users"));
        assert!(!policy.allows_outbound_uri("http://127.0.0.1/probe"));
        assert!(!policy.allows_outbound_uri("ftp://api.example.dev/v1/users"));
    }

    #[test]
    fn host_policy_allows_exact_path_prefix_without_trailing_slash() {
        let policy = HostPolicy::new(
            OutboundHttpPolicy::enabled(vec!["https://api.example.dev/v1".to_string()]),
            Vec::new(),
        );

        assert!(policy.allows_outbound_uri("https://api.example.dev/v1"));
        assert!(policy.allows_outbound_uri("https://api.example.dev/v1/users"));
        assert!(!policy.allows_outbound_uri("https://api.example.dev/v10"));
    }

    #[test]
    fn outbound_dns_rebinding_guard_blocks_private_addresses_for_hostnames() {
        assert!(!outbound_address_allowed_for_host(
            "api.example.dev",
            "127.0.0.1".parse().unwrap(),
        ));
        assert!(!outbound_address_allowed_for_host(
            "api.example.dev",
            "10.0.0.1".parse().unwrap(),
        ));
        assert!(!outbound_address_allowed_for_host(
            "api.example.dev",
            "169.254.1.1".parse().unwrap(),
        ));
        assert!(!outbound_address_allowed_for_host(
            "api.example.dev",
            "::1".parse().unwrap(),
        ));
        assert!(outbound_address_allowed_for_host(
            "api.example.dev",
            "93.184.216.34".parse().unwrap(),
        ));
        assert!(outbound_address_allowed_for_host(
            "127.0.0.1",
            "127.0.0.1".parse().unwrap(),
        ));
    }

    #[test]
    fn invocation_limits_count_subrequests() {
        let mut host = WorkerHost::with_limits_and_policy(
            InvocationLimits {
                subrequests: Some(1),
                ..InvocationLimits::default()
            },
            HostPolicy::deny_all(),
        );

        assert!(host.next_subrequest_allowed());
        assert!(!host.next_subrequest_allowed());
    }

    #[test]
    fn outbound_fetch_proxies_allowlisted_http_requests() {
        let upstream = listen_once(|request| {
            assert!(request.starts_with("POST /probe?q=1 HTTP/1.1\r\n"));
            assert!(request.contains("Host: "));
            assert!(request.ends_with("\r\n\r\npayload"));
            b"HTTP/1.1 207 Multi-Status\r\ncontent-type: text/plain\r\ncontent-length: 11\r\nconnection: close\r\n\r\nupstream-ok".to_vec()
        });
        let mut host = WorkerHost::with_limits_and_policy(
            InvocationLimits {
                subrequests: Some(1),
                ..InvocationLimits::default()
            },
            HostPolicy::with_bindings(
                OutboundHttpPolicy::enabled(vec![format!("{}/", upstream.base_url)]),
                Vec::new(),
                Vec::new(),
            ),
        );

        let response = host
            .fetch_outbound(myedge::runtime::outbound::Request {
                method: "POST".to_string(),
                uri: format!("{}/probe?q=1", upstream.base_url),
                headers: Vec::new(),
                body: b"payload".to_vec(),
            })
            .expect("outbound fetch");

        assert_eq!(response.status, 207);
        assert_eq!(response.body, b"upstream-ok");
        assert_eq!(response.headers[0].name, "content-type");
        upstream.join();
    }

    #[test]
    fn outbound_fetch_proxies_allowlisted_https_requests() {
        let upstream = listen_tls_once(|request| {
            assert!(request.starts_with("GET /secure HTTP/1.1\r\n"));
            assert!(request.contains("Host: "));
            b"HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 9\r\nconnection: close\r\n\r\ntls-works".to_vec()
        });
        let connector = trusted_test_tls_connector();
        let policy = HostPolicy::with_bindings(
            OutboundHttpPolicy::enabled(vec![format!("{}/", upstream.base_url)]),
            Vec::new(),
            Vec::new(),
        );

        let response = perform_http_fetch_with_tls_connector(
            myedge::runtime::outbound::Request {
                method: "GET".to_string(),
                uri: format!("{}/secure", upstream.base_url),
                headers: Vec::new(),
                body: Vec::new(),
            },
            &connector,
            &policy,
        )
        .expect("https outbound fetch");

        assert_eq!(response.status, 200);
        assert_eq!(response.body, b"tls-works");
        upstream.join();
    }

    #[test]
    fn outbound_fetch_follows_allowlisted_redirects() {
        let upstream = listen_many(2, |index, request, base_url| match index {
            0 => {
                assert!(request.starts_with("GET /start HTTP/1.1\r\n"));
                format!(
                    "HTTP/1.1 302 Found\r\nlocation: {base_url}/final\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                )
                .into_bytes()
            }
            1 => {
                assert!(request.starts_with("GET /final HTTP/1.1\r\n"));
                b"HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 10\r\nconnection: close\r\n\r\nredirected".to_vec()
            }
            _ => unreachable!("unexpected request"),
        });
        let mut host = WorkerHost::with_limits_and_policy(
            InvocationLimits::default(),
            HostPolicy::with_bindings(
                OutboundHttpPolicy::enabled(vec![format!("{}/", upstream.base_url)]),
                Vec::new(),
                Vec::new(),
            ),
        );

        let response = host
            .fetch_outbound(myedge::runtime::outbound::Request {
                method: "GET".to_string(),
                uri: format!("{}/start", upstream.base_url),
                headers: Vec::new(),
                body: Vec::new(),
            })
            .expect("redirected fetch");

        assert_eq!(response.status, 200);
        assert_eq!(response.body, b"redirected");
        upstream.join();
    }

    #[test]
    fn outbound_fetch_revalidates_redirects_against_allowlist() {
        let upstream = listen_many(1, |_index, _request, base_url| {
            format!(
                "HTTP/1.1 302 Found\r\nlocation: {base_url}/final\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
            )
            .into_bytes()
        });
        let mut host = WorkerHost::with_limits_and_policy(
            InvocationLimits::default(),
            HostPolicy::with_bindings(
                OutboundHttpPolicy::enabled(vec![format!("{}/start", upstream.base_url)]),
                Vec::new(),
                Vec::new(),
            ),
        );

        let response = host
            .fetch_outbound(myedge::runtime::outbound::Request {
                method: "GET".to_string(),
                uri: format!("{}/start", upstream.base_url),
                headers: Vec::new(),
                body: Vec::new(),
            })
            .expect("policy response");

        assert_eq!(response.status, 502);
        assert!(String::from_utf8_lossy(&response.body).contains("redirect"));
        upstream.join();
    }

    #[test]
    fn outbound_fetch_rejects_redirect_loops_after_limit() {
        let upstream = listen_many(MAX_OUTBOUND_REDIRECTS + 1, |_index, _request, base_url| {
            format!(
                "HTTP/1.1 302 Found\r\nlocation: {base_url}/loop\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
            )
            .into_bytes()
        });
        let mut host = WorkerHost::with_limits_and_policy(
            InvocationLimits::default(),
            HostPolicy::with_bindings(
                OutboundHttpPolicy::enabled(vec![format!("{}/", upstream.base_url)]),
                Vec::new(),
                Vec::new(),
            ),
        );

        let response = host
            .fetch_outbound(myedge::runtime::outbound::Request {
                method: "GET".to_string(),
                uri: format!("{}/loop", upstream.base_url),
                headers: Vec::new(),
                body: Vec::new(),
            })
            .expect("policy response");

        assert_eq!(response.status, 502);
        assert!(String::from_utf8_lossy(&response.body).contains("redirect limit"));
        upstream.join();
    }

    #[test]
    fn outbound_redirect_policy_rejects_https_to_http_downgrade() {
        let policy = HostPolicy::with_bindings(
            OutboundHttpPolicy::enabled(vec![
                "https://api.example.dev/".to_string(),
                "http://api.example.dev/".to_string(),
            ]),
            Vec::new(),
            Vec::new(),
        );
        let current = parse_fetch_url("https://api.example.dev/start").expect("url");
        let error = validate_redirect_target(&policy, &current, "http://api.example.dev/final")
            .expect_err("downgrade should be rejected");

        assert!(format!("{error:?}").contains("downgrade"));
    }

    #[test]
    fn outbound_fetch_denies_urls_outside_allowlist() {
        let mut host =
            WorkerHost::with_limits_and_policy(InvocationLimits::default(), HostPolicy::deny_all());

        let response = host
            .fetch_outbound(myedge::runtime::outbound::Request {
                method: "GET".to_string(),
                uri: "http://127.0.0.1/probe".to_string(),
                headers: Vec::new(),
                body: Vec::new(),
            })
            .expect("policy response");

        assert_eq!(response.status, 403);
        assert!(String::from_utf8_lossy(&response.body).contains("not allowed"));
    }

    #[test]
    fn outbound_fetch_denies_hostname_rebinding_to_loopback() {
        let mut host = WorkerHost::with_limits_and_policy(
            InvocationLimits::default(),
            HostPolicy::with_bindings(
                OutboundHttpPolicy::enabled(vec!["http://localhost/".to_string()]),
                Vec::new(),
                Vec::new(),
            ),
        );

        let response = host
            .fetch_outbound(myedge::runtime::outbound::Request {
                method: "GET".to_string(),
                uri: "http://localhost/probe".to_string(),
                headers: Vec::new(),
                body: Vec::new(),
            })
            .expect("policy response");

        assert_eq!(response.status, 502);
        assert!(String::from_utf8_lossy(&response.body).contains("allowed public address"));
    }

    #[test]
    fn invocation_limits_reject_oversized_request_bodies() {
        let error = enforce_request_body_limit(
            &HttpRequestInput {
                method: "POST".to_string(),
                uri: "https://hello.example.dev/".to_string(),
                headers: Vec::new(),
                body: b"too large".to_vec(),
            },
            InvocationLimits {
                request_bytes: Some(4),
                ..InvocationLimits::default()
            },
        )
        .expect_err("request byte limit should be enforced");

        assert!(format!("{error:?}").contains("requestBytes limit exceeded"));
    }

    #[test]
    fn invocation_limits_count_host_calls() {
        let mut host = WorkerHost::with_limits_and_policy(
            InvocationLimits {
                host_calls: Some(1),
                ..InvocationLimits::default()
            },
            HostPolicy::deny_all(),
        );

        assert!(host.check_host_call_allowed().is_ok());
        let error = host
            .check_host_call_allowed()
            .expect_err("host call limit should be enforced");
        assert!(format!("{error:?}").contains("hostCalls limit exceeded"));
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "wasmplane-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).expect("tmp dir");
        dir
    }

    fn build_async_worker_component(dir: &Path) -> PathBuf {
        let core_path = dir.join("worker.core.wasm");
        let component_path = dir.join("worker.component.wasm");
        let wit_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../wit/myedge-runtime.wit")
            .canonicalize()
            .expect("wit path");

        let status = Command::new("wasm-tools")
            .args([
                "component",
                "embed",
                wit_path.to_str().expect("utf8 wit path"),
                "--world",
                "worker",
                "--dummy-names",
                "legacy",
                "--async-stackful",
                "-o",
                core_path.to_str().expect("utf8 core path"),
            ])
            .status()
            .expect("run wasm-tools component embed");
        assert!(status.success(), "wasm-tools component embed failed");

        let status = Command::new("wasm-tools")
            .args([
                "component",
                "new",
                "--skip-validation",
                core_path.to_str().expect("utf8 core path"),
                "-o",
                component_path.to_str().expect("utf8 component path"),
            ])
            .status()
            .expect("run wasm-tools component new");
        assert!(status.success(), "wasm-tools component new failed");

        component_path
    }

    struct UpstreamServer {
        base_url: String,
        handle: std::thread::JoinHandle<()>,
    }

    impl UpstreamServer {
        fn join(self) {
            self.handle.join().expect("upstream thread");
        }
    }

    fn listen_once(handler: impl FnOnce(String) -> Vec<u8> + Send + 'static) -> UpstreamServer {
        let mut handler = Some(handler);
        listen_many(1, move |_index, request, _base_url| {
            handler.take().expect("single request handler")(request)
        })
    }

    fn listen_many(
        requests: usize,
        mut handler: impl FnMut(usize, String, String) -> Vec<u8> + Send + 'static,
    ) -> UpstreamServer {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind upstream");
        let address = listener.local_addr().expect("upstream address");
        let base_url = format!("http://{address}");
        let thread_base_url = base_url.clone();
        let handle = std::thread::spawn(move || {
            for index in 0..requests {
                let (mut stream, _) = listener.accept().expect("accept upstream request");
                let mut request = Vec::new();
                let mut buffer = [0; 1024];
                loop {
                    let read = stream.read(&mut buffer).expect("read upstream request");
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..read]);
                    if request.windows(4).any(|window| window == b"\r\n\r\n") {
                        let request_text = String::from_utf8_lossy(&request);
                        if let Some(length) = content_length(&request_text) {
                            let header_end = request
                                .windows(4)
                                .position(|window| window == b"\r\n\r\n")
                                .expect("headers");
                            if request.len() >= header_end + 4 + length {
                                break;
                            }
                        } else {
                            break;
                        }
                    }
                }
                let response = handler(
                    index,
                    String::from_utf8_lossy(&request).into_owned(),
                    thread_base_url.clone(),
                );
                stream
                    .write_all(&response)
                    .expect("write upstream response");
            }
        });
        UpstreamServer { base_url, handle }
    }

    fn listen_tls_once(handler: impl FnOnce(String) -> Vec<u8> + Send + 'static) -> UpstreamServer {
        let identity =
            Identity::from_pkcs8(TEST_TLS_CERT_PEM.as_bytes(), TEST_TLS_KEY_PEM.as_bytes())
                .expect("test tls identity");
        let acceptor = TlsAcceptor::new(identity).expect("test tls acceptor");
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind tls upstream");
        let address = listener.local_addr().expect("tls upstream address");
        let handle = std::thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept tls upstream request");
            let mut stream = acceptor.accept(stream).expect("accept test tls");
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            loop {
                let read = stream.read(&mut buffer).expect("read tls upstream request");
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let request_text = String::from_utf8_lossy(&request);
                    if let Some(length) = content_length(&request_text) {
                        let header_end = request
                            .windows(4)
                            .position(|window| window == b"\r\n\r\n")
                            .expect("headers");
                        if request.len() >= header_end + 4 + length {
                            break;
                        }
                    } else {
                        break;
                    }
                }
            }
            let response = handler(String::from_utf8_lossy(&request).into_owned());
            stream
                .write_all(&response)
                .expect("write tls upstream response");
        });
        UpstreamServer {
            base_url: format!("https://{address}"),
            handle,
        }
    }

    fn trusted_test_tls_connector() -> TlsConnector {
        // Test-only connector for the self-signed local fixture. Production uses TlsConnector::new().
        let mut builder = TlsConnector::builder();
        builder.danger_accept_invalid_certs(true);
        builder.danger_accept_invalid_hostnames(true);
        builder.build().expect("test tls connector")
    }

    fn content_length(request: &str) -> Option<usize> {
        request.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if name.eq_ignore_ascii_case("content-length") {
                value.trim().parse().ok()
            } else {
                None
            }
        })
    }

    const TEST_TLS_CERT_PEM: &str = r#"-----BEGIN CERTIFICATE-----
MIICyTCCAbGgAwIBAgIJALzWUGNZ9OqRMA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNV
BAMMCWxvY2FsaG9zdDAeFw0yNjA2MjYxNjE3MThaFw0zNjA2MjMxNjE3MThaMBQx
EjAQBgNVBAMMCWxvY2FsaG9zdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoC
ggEBANzpQ0OCgvrAkw6xjkcUDYbTFJDz3/hdUX0S8AJhW0QLxgsg5KRPb+mc6S82
kAOWbrzrcQUrC+lEAE6fTGSlE03jPFDSlBPZOEt1+qPhduQXjVc0g0yxNvzTOzdV
+5EV3Noioi4enKpsu3F1nlYd+Twtw0xaTGIq1KTxpME0IFa1LCukOK203WkLGpub
PY1V3DO6/QPXlkw37bdlNJRvETZww4HY6JCeK8zdvKfrbV+xu1v/Xd7adNY6iIsQ
qlnHqw5pX+dJhe8ZyYkyouHFAtDNQ/fn/xBJ48tOYNn/PbJCG1QJI1jqxD32M4P+
mDprjZ3QAHZTkNaeoLtgin9mglkCAwEAAaMeMBwwGgYDVR0RBBMwEYIJbG9jYWxo
b3N0hwR/AAABMA0GCSqGSIb3DQEBCwUAA4IBAQAU3Sh6viD5OhgfM+yEUcOE4Nqg
hzAHEP0xUzPmamXE1gUctmi4xLVojdvOoEvWVzWOsp/jPZVrRVbCJkalQz3iTevc
eQM1h/qKAe9UabRQ0YSLVWKbhRJMNY8i0GDaUE5kdRj1oF9l05KzFrhiEpfcImg/
6UtciUvM4hA8PTsykgBWzeSjIMcnaAyYHtuQ8VALY5I/gvj6w8zRWIdW/eN/Re4y
kCTCuaFXBU/B5npHrhfRK3rgNSoTYDTG/t6nXO6cjfm3lISBKuGqeh9lkUk20gkI
VPOzAUVY9zo0BDaX2kPrul0aLtRJyZZUi8MOJdgziPXG/bQunv/p6Lsva10H
-----END CERTIFICATE-----"#;

    const TEST_TLS_KEY_PEM: &str = r#"-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDc6UNDgoL6wJMO
sY5HFA2G0xSQ89/4XVF9EvACYVtEC8YLIOSkT2/pnOkvNpADlm6863EFKwvpRABO
n0xkpRNN4zxQ0pQT2ThLdfqj4XbkF41XNINMsTb80zs3VfuRFdzaIqIuHpyqbLtx
dZ5WHfk8LcNMWkxiKtSk8aTBNCBWtSwrpDittN1pCxqbmz2NVdwzuv0D15ZMN+23
ZTSUbxE2cMOB2OiQnivM3byn621fsbtb/13e2nTWOoiLEKpZx6sOaV/nSYXvGcmJ
MqLhxQLQzUP35/8QSePLTmDZ/z2yQhtUCSNY6sQ99jOD/pg6a42d0AB2U5DWnqC7
YIp/ZoJZAgMBAAECggEAXrnPU/V0wJ0u8dAFGElq+3MrkHRih5dMR/uE2yBwCB+c
Tk1OfX5qmJvmCY619jPdTDkQ/4xT0TSNhSkdktKOEonr5SRGxrQQRZtTXE5jsq6+
trQX0Rz0XTkeXT4LX00mpIrRTEFoIFP7lE1BFeBIbRuacPUPZ9DB2fCcGxSFAWhm
inh+nNO4f1b0dbqpFwQaIqWZyHSD8Vke8jRBAq0mWNXU6sw7prdqgasO8lEZGdQC
NLCn2tP+NCqWXez1f1ZqR6SOPk/oDJvCmjps+xEUE2Y2XQDqRRilCVzL3Ww9LiIa
bMNJwUoxT8woGeTkq41rcALUHa6xECMJxqmZt8hK4QKBgQDyaPbkvbKzT4EpKXrd
3/E8H3iGsZiANODRPpv2o7LO7grXlHmeYevLlP6xNiTA2AI3CClf47ADGFiVEgJY
M58ePqYmbvLlwqap16kRPvitlm+HNXOmQiaFd79sBnTY6tup3IIjNg3YS3MPgJpU
Pw/HNuLIbs7wC7J/4ZiG5L6vrQKBgQDpS7/+KsNHBb1JfmC8N2AiAz7Cfu+OI8GV
FwvukYUG2fgUVP5N2qQnU9wyZzCylrAw0mXY2tPt8QkLf+BJLrQ9wd8xNXQsld5a
EYHsiW+yA8dEFPClWDbX/r+35hrsFzBvnm2ibcgJbSIfo+B2MLjd6QKkxqZdEFZP
u1erjj+C3QKBgEkDzLoBWX4hCGp5kAScm3DcmdUYUTLsunrMPPYBQK6LjMB6fFd0
by2W51BBWrirV59z2eKEFlQYVTYxgntGsTrO7ATPjmIeS00FJGuJaCYBFf7H3tnJ
OwkglIvZNgDQXPHA9YHdmjX4I+QbfGC7zejXY1+z4Kj1HQLf1K1s4PLRAoGAeNmp
miNSxw69ED4sJDPXU6c0spIIzCvPksi+gJXXQEZXUUj59yCEmm7BiUaVHl4a5R+I
bL5mvEJ5OgDDEYXlDnzIfng/Nv1nkmaxU/OZ7bAxYB4szqoUtu0bKUtEtPoKODfs
eRC/Z8qlu5grpW31xdZ3bR4OffUBkQnuD0t/sO0CgYEA2T7okKzCO1lVhcVXv9Ft
43VgWVAG/Ef1AyndNxf6YffJNIjdkYYs+Er4/l5BUybVTjkNVPMywWiUgGP7//wO
XjsKL6zBwgFiWtW1thvEGITmAucOJzAg3GWlwk2b576Hjm8PHK5gxzatvifwPs19
RE8ffzBnwu+O7+fKnA7hQss=
-----END PRIVATE KEY-----"#;
}
