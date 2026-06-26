use std::collections::HashMap;
use std::path::Path;

use anyhow::Result;
use wasmtime::component::{Component, HasData, Linker, Resource, ResourceTable, bindgen};
use wasmtime::{Config, Engine, Store};
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
    },
});

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

pub struct WorkerHost {
    table: ResourceTable,
    wasi: WasiCtx,
    kv: HashMap<(String, String), Vec<u8>>,
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
        Self {
            table: ResourceTable::new(),
            wasi: WasiCtx::builder().inherit_stdio().inherit_env().build(),
            kv: HashMap::new(),
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
        Ok(self.table.push(KvNamespace { id: id.into() })?)
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
impl myedge::runtime::kv::Host for WorkerHost {}
impl myedge::runtime::http::Host for WorkerHost {
    async fn new_outgoing_body(&mut self) -> wasmtime::Result<Resource<OutgoingBody>> {
        Ok(self.table.push(OutgoingBody {
            chunks: Vec::new(),
            finished: false,
        })?)
    }
}
impl myedge::runtime::outbound::Host for WorkerHost {}

impl myedge::runtime::kv::HostNamespace for WorkerHost {
    async fn drop(&mut self, rep: Resource<KvNamespace>) -> wasmtime::Result<()> {
        self.table.delete(rep)?;
        Ok(())
    }
}

impl myedge::runtime::kv::HostWithStore for WorkerHost {
    async fn get<T: Send>(
        accessor: &wasmtime::component::Accessor<T, Self>,
        ns: Resource<KvNamespace>,
        key: String,
    ) -> wasmtime::Result<Option<Vec<u8>>> {
        accessor.with(|mut access| {
            let host = access.get();
            let namespace = host.table.get(&ns)?.id.clone();
            Ok(host.kv.get(&(namespace, key)).cloned())
        })
    }

    async fn put<T: Send>(
        accessor: &wasmtime::component::Accessor<T, Self>,
        ns: Resource<KvNamespace>,
        key: String,
        value: Vec<u8>,
        _ttl_seconds: Option<u64>,
    ) -> wasmtime::Result<()> {
        accessor.with(|mut access| {
            let host = access.get();
            let namespace = host.table.get(&ns)?.id.clone();
            host.kv.insert((namespace, key), value);
            Ok(())
        })
    }

    async fn delete<T: Send>(
        accessor: &wasmtime::component::Accessor<T, Self>,
        ns: Resource<KvNamespace>,
        key: String,
    ) -> wasmtime::Result<()> {
        accessor.with(|mut access| {
            let host = access.get();
            let namespace = host.table.get(&ns)?.id.clone();
            host.kv.remove(&(namespace, key));
            Ok(())
        })
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
            let body = host.table.get_mut(&self_)?;
            if body.finished {
                wasmtime::bail!("outgoing body already finished");
            }
            body.chunks.push(chunk);
            Ok(())
        })
    }

    async fn finish<T: Send>(
        accessor: &wasmtime::component::Accessor<T, Self>,
        self_: Resource<OutgoingBody>,
    ) -> wasmtime::Result<()> {
        accessor.with(|mut access| {
            let host = access.get();
            let body = host.table.get_mut(&self_)?;
            body.finished = true;
            Ok(())
        })
    }
}

impl myedge::runtime::outbound::HostWithStore for WorkerHost {
    async fn fetch<T: Send>(
        accessor: &wasmtime::component::Accessor<T, Self>,
        _req: myedge::runtime::outbound::Request,
    ) -> wasmtime::Result<myedge::runtime::outbound::Response> {
        accessor.with(|mut access| {
            let host = access.get();
            let body = host.table.push(OutgoingBody {
                chunks: vec![b"outbound fetch is not enabled".to_vec()],
                finished: true,
            })?;
            Ok(myedge::runtime::outbound::Response {
                head: myedge::runtime::types::ResponseHead {
                    status: 502,
                    headers: Vec::new(),
                },
                body,
            })
        })
    }
}

impl myedge::runtime::log::Host for WorkerHost {
    async fn info(&mut self, message: String) -> wasmtime::Result<()> {
        self.logs.push(LogEvent {
            level: LogLevel::Info,
            message,
        });
        Ok(())
    }

    async fn warn(&mut self, message: String) -> wasmtime::Result<()> {
        self.logs.push(LogEvent {
            level: LogLevel::Warn,
            message,
        });
        Ok(())
    }

    async fn error(&mut self, message: String) -> wasmtime::Result<()> {
        self.logs.push(LogEvent {
            level: LogLevel::Error,
            message,
        });
        Ok(())
    }
}

pub fn wasip3_engine() -> Result<Engine> {
    let mut config = Config::new();
    config.wasm_component_model(true);
    config.wasm_component_model_async(true);
    config.wasm_component_model_async_stackful(true);
    config.concurrency_support(true);
    Ok(Engine::new(&config)?)
}

pub fn precompile_component(component_path: &Path, output_path: &Path) -> Result<CompileReport> {
    let engine = wasip3_engine()?;
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
    let engine = wasip3_engine()?;
    let component = Component::from_file(&engine, component_path)?;
    let mut linker = Linker::<WorkerHost>::new(&engine);
    add_worker_imports(&mut linker)?;
    let mut store = Store::new(&engine, WorkerHost::new());
    let worker =
        futures::executor::block_on(Worker::instantiate_async(&mut store, &component, &linker))?;

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
    })?;

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

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::process::Command;

    use super::*;

    #[test]
    fn engine_enables_wasip3_component_async_features() {
        let engine = wasip3_engine().expect("engine");
        Component::new(&engine, "(component)").expect("empty component compiles");
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

        futures::executor::block_on(Worker::instantiate_async(&mut store, &component, &linker))
            .expect("instantiate");
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
}
