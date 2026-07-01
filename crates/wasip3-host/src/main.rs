use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use serde_json::Value;
use wasmplane_wasip3_host::{
    HostPolicy, HttpRequestInput, InstanceReuseContract, InvocationLimits, KvBindingPolicy,
    OutboundHttpPolicy, SecretBindingPolicy, Wasip3PoolingConfig, Wasip3Runtime,
    Wasip3RuntimeOptions, invoke_component_handle_with_limits_and_policy,
    invoke_component_handle_with_persistent_kv,
    invoke_precompiled_component_handle_with_limits_and_policy,
    invoke_precompiled_component_handle_with_persistent_kv, precompile_component_with_pooling,
};

#[derive(Debug, PartialEq, Eq)]
enum InvokeSource {
    Component(PathBuf),
    Precompiled(PathBuf),
}

impl InvokeSource {
    fn path(&self) -> &PathBuf {
        match self {
            Self::Component(path) | Self::Precompiled(path) => path,
        }
    }
}

#[derive(Debug)]
struct InvokeArgs {
    source: InvokeSource,
    method: String,
    uri: String,
    headers: Vec<(String, String)>,
    body: String,
    limits: InvocationLimits,
    policy: HostPolicy,
    kv_store_dir: Option<PathBuf>,
}

#[derive(Debug, PartialEq, Eq)]
struct CompileArgs {
    component: PathBuf,
    output: PathBuf,
    pooling: Option<Wasip3PoolingConfig>,
}

#[derive(Debug, PartialEq, Eq)]
struct ServeArgs {
    host: String,
    port: u16,
    kv_store_dir: Option<PathBuf>,
    runtime_options: Wasip3RuntimeOptions,
    max_concurrent_invocations: usize,
}

const DEFAULT_MAX_CONCURRENT_INVOCATIONS: usize = 128;

#[derive(Debug, Default)]
struct PoolingArgs {
    total_component_instances: Option<u32>,
    memory_mb: Option<u64>,
    total_core_instances: Option<u32>,
    total_memories: Option<u32>,
    total_tables: Option<u32>,
    table_elements: Option<usize>,
    component_instance_mb: Option<u64>,
    core_instance_mb: Option<u64>,
}

impl PoolingArgs {
    fn set(&mut self, flag: &str, value: &str) -> Result<bool> {
        match flag {
            "--pooling-total-component-instances" => {
                self.total_component_instances =
                    Some(parse_u32(value, "--pooling-total-component-instances")?);
            }
            "--pooling-memory-mb" => {
                self.memory_mb = Some(parse_u64(value, "--pooling-memory-mb")?);
            }
            "--pooling-total-core-instances" => {
                self.total_core_instances =
                    Some(parse_u32(value, "--pooling-total-core-instances")?);
            }
            "--pooling-total-memories" => {
                self.total_memories = Some(parse_u32(value, "--pooling-total-memories")?);
            }
            "--pooling-total-tables" => {
                self.total_tables = Some(parse_u32(value, "--pooling-total-tables")?);
            }
            "--pooling-table-elements" => {
                self.table_elements = Some(parse_usize(value, "--pooling-table-elements")?);
            }
            "--pooling-component-instance-mb" => {
                self.component_instance_mb =
                    Some(parse_u64(value, "--pooling-component-instance-mb")?);
            }
            "--pooling-core-instance-mb" => {
                self.core_instance_mb = Some(parse_u64(value, "--pooling-core-instance-mb")?);
            }
            _ => return Ok(false),
        }
        Ok(true)
    }

    fn finish(self) -> Option<Wasip3PoolingConfig> {
        self.total_component_instances.map(|slots| {
            let mut config =
                Wasip3PoolingConfig::for_component_slots(slots, self.memory_mb.unwrap_or(64));
            if let Some(value) = self.total_core_instances {
                config.total_core_instances = value;
            }
            if let Some(value) = self.total_memories {
                config.total_memories = value;
            }
            if let Some(value) = self.total_tables {
                config.total_tables = value;
            }
            if let Some(value) = self.table_elements {
                config.table_elements = value;
            }
            if let Some(value) = self.component_instance_mb {
                config.max_component_instance_size = mb_to_usize(value);
            }
            if let Some(value) = self.core_instance_mb {
                config.max_core_instance_size = mb_to_usize(value);
            }
            config
        })
    }
}

struct DaemonState {
    runtime: Arc<Wasip3Runtime>,
    kv_store_dir: Option<PathBuf>,
    admission: Arc<AdmissionLimiter>,
    metrics: Arc<DaemonMetrics>,
}

impl DaemonState {
    fn new(
        runtime: Arc<Wasip3Runtime>,
        kv_store_dir: Option<PathBuf>,
        max_concurrent_invocations: usize,
    ) -> Self {
        Self {
            runtime,
            kv_store_dir,
            admission: Arc::new(AdmissionLimiter::new(max_concurrent_invocations)),
            metrics: Arc::new(DaemonMetrics::default()),
        }
    }
}

struct AdmissionLimiter {
    max: usize,
    active: AtomicUsize,
}

struct AdmissionPermit {
    limiter: Arc<AdmissionLimiter>,
}

impl AdmissionLimiter {
    fn new(max: usize) -> Self {
        Self {
            max: max.max(1),
            active: AtomicUsize::new(0),
        }
    }

    fn try_acquire(self: &Arc<Self>) -> Option<AdmissionPermit> {
        let mut current = self.active.load(Ordering::Acquire);
        loop {
            if current >= self.max {
                return None;
            }
            match self.active.compare_exchange_weak(
                current,
                current + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    return Some(AdmissionPermit {
                        limiter: Arc::clone(self),
                    });
                }
                Err(next) => current = next,
            }
        }
    }

    fn active(&self) -> usize {
        self.active.load(Ordering::Acquire)
    }

    fn max(&self) -> usize {
        self.max
    }
}

impl Drop for AdmissionPermit {
    fn drop(&mut self) {
        self.limiter.active.fetch_sub(1, Ordering::AcqRel);
    }
}

#[derive(Default)]
struct DaemonMetrics {
    ok_invocations: AtomicU64,
    failed_invocations: AtomicU64,
    rejected_invocations: AtomicU64,
    total_duration_micros: AtomicU64,
}

impl DaemonMetrics {
    fn record_invoke(&self, duration: Duration, ok: bool) {
        if ok {
            self.ok_invocations.fetch_add(1, Ordering::Relaxed);
        } else {
            self.failed_invocations.fetch_add(1, Ordering::Relaxed);
        }
        let micros = u64::try_from(duration.as_micros()).unwrap_or(u64::MAX);
        self.total_duration_micros
            .fetch_add(micros, Ordering::Relaxed);
    }

    fn record_rejected(&self) {
        self.rejected_invocations.fetch_add(1, Ordering::Relaxed);
    }

    fn ok_invocations(&self) -> u64 {
        self.ok_invocations.load(Ordering::Relaxed)
    }

    fn failed_invocations(&self) -> u64 {
        self.failed_invocations.load(Ordering::Relaxed)
    }

    fn total_invocations(&self) -> u64 {
        self.ok_invocations() + self.failed_invocations()
    }

    fn rejected_invocations(&self) -> u64 {
        self.rejected_invocations.load(Ordering::Relaxed)
    }

    fn total_duration_seconds(&self) -> f64 {
        self.total_duration_micros.load(Ordering::Relaxed) as f64 / 1_000_000.0
    }

    fn avg_invoke_ms(&self) -> f64 {
        let total = self.total_invocations();
        if total == 0 {
            0.0
        } else {
            self.total_duration_micros.load(Ordering::Relaxed) as f64 / total as f64 / 1000.0
        }
    }
}

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let Some(command) = args.next() else {
        print_usage();
        bail!("missing command");
    };

    match command.as_str() {
        "compile" => {
            let compile_args = parse_compile_args(&mut args)?;
            let report = precompile_component_with_pooling(
                &compile_args.component,
                &compile_args.output,
                compile_args.pooling.as_ref(),
            )
            .with_context(|| {
                format!("failed to precompile {}", compile_args.component.display())
            })?;
            println!(
                "{{\"wasi\":\"{}\",\"component\":\"{}\",\"precompiled\":\"{}\",\"bytes\":{}}}",
                report.wasi_profile,
                json_escape(&report.component_path),
                json_escape(&report.precompiled_path),
                report.bytes
            );
            Ok(())
        }
        "invoke" => {
            let invoke_args = parse_invoke_args(&mut args)?;
            let request = HttpRequestInput {
                method: invoke_args.method,
                uri: invoke_args.uri,
                headers: invoke_args.headers,
                body: invoke_args.body.into_bytes(),
            };
            let source_label = invoke_args.source.path().display().to_string();
            let response = match (invoke_args.source, invoke_args.kv_store_dir) {
                (InvokeSource::Component(component), Some(kv_store_dir)) => {
                    invoke_component_handle_with_persistent_kv(
                        &component,
                        request,
                        invoke_args.limits,
                        invoke_args.policy,
                        &kv_store_dir,
                    )
                }
                (InvokeSource::Component(component), None) => {
                    invoke_component_handle_with_limits_and_policy(
                        &component,
                        request,
                        invoke_args.limits,
                        invoke_args.policy,
                    )
                }
                (InvokeSource::Precompiled(precompiled), Some(kv_store_dir)) => {
                    invoke_precompiled_component_handle_with_persistent_kv(
                        &precompiled,
                        request,
                        invoke_args.limits,
                        invoke_args.policy,
                        &kv_store_dir,
                    )
                }
                (InvokeSource::Precompiled(precompiled), None) => {
                    invoke_precompiled_component_handle_with_limits_and_policy(
                        &precompiled,
                        request,
                        invoke_args.limits,
                        invoke_args.policy,
                    )
                }
            }
            .with_context(|| format!("failed to invoke {source_label}"))?;
            println!(
                "{{\"status\":{},\"headers\":{},\"body\":\"{}\"}}",
                response.status,
                headers_json(&response.headers),
                json_escape(&String::from_utf8_lossy(&response.body))
            );
            Ok(())
        }
        "serve" => {
            let serve_args = parse_serve_args(&mut args)?;
            serve(serve_args)
        }
        _ => {
            print_usage();
            bail!("unknown command {command}");
        }
    }
}

fn parse_compile_args(args: &mut impl Iterator<Item = String>) -> Result<CompileArgs> {
    let mut component = None;
    let mut output = None;
    let mut pooling = PoolingArgs::default();

    while let Some(flag) = args.next() {
        let Some(value) = args.next() else {
            bail!("expected {flag} <value>");
        };
        match flag.as_str() {
            "--component" => component = Some(PathBuf::from(value)),
            "--out" => output = Some(PathBuf::from(value)),
            _ if pooling.set(flag.as_str(), &value)? => {}
            _ => bail!("unexpected argument {flag}"),
        }
    }

    Ok(CompileArgs {
        component: component.context("expected --component <path>")?,
        output: output.context("expected --out <path>")?,
        pooling: pooling.finish(),
    })
}

fn parse_serve_args(args: &mut impl Iterator<Item = String>) -> Result<ServeArgs> {
    let mut host = "127.0.0.1".to_string();
    let mut port = 8789;
    let mut kv_store_dir = None;
    let mut max_prepared_components = Wasip3RuntimeOptions::default().max_prepared_components;
    let mut max_reusable_instances_per_component =
        Wasip3RuntimeOptions::default().max_reusable_instances_per_component;
    let mut instance_reuse_contract = Wasip3RuntimeOptions::default().instance_reuse_contract;
    let mut max_concurrent_invocations = DEFAULT_MAX_CONCURRENT_INVOCATIONS;
    let mut pooling = PoolingArgs::default();

    while let Some(flag) = args.next() {
        let Some(value) = args.next() else {
            bail!("expected {flag} <value>");
        };
        match flag.as_str() {
            "--host" => host = value,
            "--port" => port = parse_u16(&value, "--port")?,
            "--kv-store-dir" => kv_store_dir = Some(PathBuf::from(value)),
            "--max-prepared-components" => {
                max_prepared_components = parse_usize(&value, "--max-prepared-components")?
            }
            "--max-concurrent-invocations" => {
                max_concurrent_invocations = parse_usize(&value, "--max-concurrent-invocations")?
            }
            "--experimental-instance-reuse" => {
                max_reusable_instances_per_component =
                    parse_usize(&value, "--experimental-instance-reuse")?
            }
            "--instance-reuse-contract" => {
                instance_reuse_contract = parse_instance_reuse_contract(&value)?
            }
            _ if pooling.set(flag.as_str(), &value)? => {}
            _ => bail!("unexpected argument {flag}"),
        }
    }

    Ok(ServeArgs {
        host,
        port,
        kv_store_dir,
        runtime_options: Wasip3RuntimeOptions {
            max_prepared_components,
            max_reusable_instances_per_component,
            instance_reuse_contract,
            pooling: pooling.finish(),
        },
        max_concurrent_invocations,
    })
}

fn serve(args: ServeArgs) -> Result<()> {
    let listener = TcpListener::bind((args.host.as_str(), args.port))
        .with_context(|| format!("failed to bind {}:{}", args.host, args.port))?;
    let runtime = Arc::new(Wasip3Runtime::with_options(args.runtime_options)?);
    let state = Arc::new(DaemonState::new(
        runtime,
        args.kv_store_dir.clone(),
        args.max_concurrent_invocations,
    ));
    eprintln!(
        "wasmplane-wasip3-host serving on http://{}:{}",
        args.host, args.port
    );
    for stream in listener.incoming() {
        let state = Arc::clone(&state);
        match stream {
            Ok(stream) => {
                thread::spawn(move || {
                    let _ = handle_daemon_connection(stream, state);
                });
            }
            Err(error) => eprintln!("failed to accept daemon connection: {error}"),
        }
    }
    Ok(())
}

fn parse_invoke_args(args: &mut impl Iterator<Item = String>) -> Result<InvokeArgs> {
    let mut component = None;
    let mut precompiled = None;
    let mut method = None;
    let mut uri = None;
    let mut headers = Vec::new();
    let mut body = String::new();
    let mut limits = InvocationLimits::default();
    let mut policy = HostPolicy::deny_all();
    let mut kv_store_dir = None;

    while let Some(flag) = args.next() {
        let Some(value) = args.next() else {
            bail!("expected {flag} <value>");
        };
        match flag.as_str() {
            "--component" => component = Some(PathBuf::from(value)),
            "--precompiled" => precompiled = Some(PathBuf::from(value)),
            "--method" => method = Some(value),
            "--uri" => uri = Some(value),
            "--headers" => headers = parse_headers_arg(&value)?,
            "--body" => body = value,
            "--wall-ms" => limits.wall_ms = Some(parse_u64(&value, "--wall-ms")?),
            "--cpu-ms" => limits.cpu_ms = Some(parse_u64(&value, "--cpu-ms")?),
            "--memory-mb" => limits.memory_mb = Some(parse_u64(&value, "--memory-mb")?),
            "--request-bytes" => {
                limits.request_bytes = Some(parse_usize(&value, "--request-bytes")?)
            }
            "--response-bytes" => {
                limits.response_bytes = Some(parse_usize(&value, "--response-bytes")?)
            }
            "--subrequests" => limits.subrequests = Some(parse_u32(&value, "--subrequests")?),
            "--host-calls" => limits.host_calls = Some(parse_u32(&value, "--host-calls")?),
            "--capabilities" => policy = parse_host_policy(&value)?,
            "--kv-store-dir" => kv_store_dir = Some(PathBuf::from(value)),
            _ => bail!("unexpected argument {flag}"),
        }
    }

    let source = match (component, precompiled) {
        (Some(component), None) => InvokeSource::Component(component),
        (None, Some(precompiled)) => InvokeSource::Precompiled(precompiled),
        (Some(_), Some(_)) => bail!("expected exactly one of --component or --precompiled"),
        (None, None) => bail!("expected --component <path> or --precompiled <path>"),
    };

    Ok(InvokeArgs {
        source,
        method: method.context("expected --method <value>")?,
        uri: uri.context("expected --uri <value>")?,
        headers,
        body,
        limits,
        policy,
        kv_store_dir,
    })
}

struct DaemonHttpRequest {
    method: String,
    path: String,
    body: Vec<u8>,
}

fn handle_daemon_connection(mut stream: TcpStream, state: Arc<DaemonState>) -> Result<()> {
    let request = read_daemon_http_request(&mut stream)?;
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/healthz") => write_http_json(&mut stream, 200, r#"{"ok":true}"#),
        ("GET", "/stats") => write_http_json(&mut stream, 200, &daemon_stats_json(&state)),
        ("GET", "/metrics") => write_http_text(&mut stream, 200, &daemon_metrics_text(&state)),
        ("POST", "/invoke") => {
            let Some(_permit) = state.admission.try_acquire() else {
                state.metrics.record_rejected();
                return write_http_json(
                    &mut stream,
                    503,
                    r#"{"error":{"code":"busy","message":"daemon concurrency limit reached"}}"#,
                );
            };
            let started_at = Instant::now();
            let result = handle_daemon_invoke(
                Arc::clone(&state.runtime),
                state.kv_store_dir.as_deref(),
                &request.body,
            );
            state
                .metrics
                .record_invoke(started_at.elapsed(), result.is_ok());
            match result {
                Ok(response) => write_http_json(
                    &mut stream,
                    200,
                    &format!(
                        "{{\"status\":{},\"headers\":{},\"body\":\"{}\"}}",
                        response.status,
                        headers_json(&response.headers),
                        json_escape(&String::from_utf8_lossy(&response.body))
                    ),
                ),
                Err(error) => write_http_json(
                    &mut stream,
                    500,
                    &format!(
                        "{{\"error\":{{\"code\":\"invoke\",\"message\":\"{}\"}}}}",
                        json_escape(&format!("{error:#}"))
                    ),
                ),
            }
        }
        _ => write_http_json(
            &mut stream,
            404,
            r#"{"error":{"code":"not_found","message":"daemon endpoint not found"}}"#,
        ),
    }
}

fn handle_daemon_invoke(
    runtime: Arc<Wasip3Runtime>,
    kv_store_dir: Option<&Path>,
    body: &[u8],
) -> Result<wasmplane_wasip3_host::HttpResponseOutput> {
    let json: Value = serde_json::from_slice(body).context("invoke body must be JSON")?;
    let invoke_args = parse_daemon_invoke(&json)?;
    let request = HttpRequestInput {
        method: invoke_args.method,
        uri: invoke_args.uri,
        headers: invoke_args.headers,
        body: invoke_args.body.into_bytes(),
    };

    match (invoke_args.source, kv_store_dir) {
        (InvokeSource::Component(component), Some(kv_store_dir)) => runtime
            .invoke_component_handle_with_persistent_kv(
                &component,
                request,
                invoke_args.limits,
                invoke_args.policy,
                kv_store_dir,
            ),
        (InvokeSource::Component(component), None) => runtime
            .invoke_component_handle_with_limits_and_policy(
                &component,
                request,
                invoke_args.limits,
                invoke_args.policy,
            ),
        (InvokeSource::Precompiled(precompiled), Some(kv_store_dir)) => runtime
            .invoke_precompiled_component_handle_with_persistent_kv(
                &precompiled,
                request,
                invoke_args.limits,
                invoke_args.policy,
                kv_store_dir,
            ),
        (InvokeSource::Precompiled(precompiled), None) => runtime
            .invoke_precompiled_component_handle_with_limits_and_policy(
                &precompiled,
                request,
                invoke_args.limits,
                invoke_args.policy,
            ),
    }
}

fn parse_daemon_invoke(value: &Value) -> Result<InvokeArgs> {
    let object = value
        .as_object()
        .context("invoke body must be a JSON object")?;
    let component = object
        .get("component")
        .and_then(Value::as_str)
        .map(PathBuf::from);
    let precompiled = object
        .get("precompiled")
        .and_then(Value::as_str)
        .map(PathBuf::from);
    let source = match (component, precompiled) {
        (Some(component), None) => InvokeSource::Component(component),
        (None, Some(precompiled)) => InvokeSource::Precompiled(precompiled),
        (Some(_), Some(_)) => bail!("expected exactly one of component or precompiled"),
        (None, None) => bail!("expected component or precompiled"),
    };
    let method = object
        .get("method")
        .and_then(Value::as_str)
        .context("invoke body must include method")?
        .to_string();
    let uri = object
        .get("uri")
        .and_then(Value::as_str)
        .context("invoke body must include uri")?
        .to_string();
    let headers = object
        .get("headers")
        .map(parse_headers_value)
        .transpose()?
        .unwrap_or_default();
    let body = object
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let limits = object
        .get("limits")
        .map(parse_limits_value)
        .transpose()?
        .unwrap_or_default();
    let policy = object
        .get("capabilities")
        .map(|capabilities| parse_host_policy(&capabilities.to_string()))
        .transpose()?
        .unwrap_or_else(HostPolicy::deny_all);

    Ok(InvokeArgs {
        source,
        method,
        uri,
        headers,
        body,
        limits,
        policy,
        kv_store_dir: None,
    })
}

fn read_daemon_http_request(stream: &mut TcpStream) -> Result<DaemonHttpRequest> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 8192];
    let header_end = loop {
        let read = stream.read(&mut buffer)?;
        if read == 0 {
            bail!("connection closed before HTTP headers");
        }
        bytes.extend_from_slice(&buffer[..read]);
        if bytes.len() > 64 * 1024 {
            bail!("HTTP headers exceeded 64KB");
        }
        if let Some(index) = find_header_end(&bytes) {
            break index;
        }
    };
    let headers =
        std::str::from_utf8(&bytes[..header_end]).context("HTTP headers must be UTF-8")?;
    let mut lines = headers.split("\r\n");
    let request_line = lines.next().context("HTTP request line is missing")?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts
        .next()
        .context("HTTP method is missing")?
        .to_string();
    let path = request_parts
        .next()
        .context("HTTP path is missing")?
        .to_string();
    let content_length = lines
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .map(|(_, value)| value.trim().parse::<usize>())
        .transpose()
        .context("invalid content-length")?
        .unwrap_or(0);
    let body_start = header_end + 4;
    while bytes.len().saturating_sub(body_start) < content_length {
        let read = stream.read(&mut buffer)?;
        if read == 0 {
            bail!("connection closed before HTTP body");
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
    Ok(DaemonHttpRequest {
        method,
        path,
        body: bytes[body_start..body_start + content_length].to_vec(),
    })
}

fn write_http_json(stream: &mut TcpStream, status: u16, body: &str) -> Result<()> {
    write_http_response(stream, status, "application/json; charset=utf-8", body)
}

fn write_http_text(stream: &mut TcpStream, status: u16, body: &str) -> Result<()> {
    write_http_response(
        stream,
        status,
        "text/plain; version=0.0.4; charset=utf-8",
        body,
    )
}

fn write_http_response(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &str,
) -> Result<()> {
    let reason = match status {
        200 => "OK",
        404 => "Not Found",
        503 => "Service Unavailable",
        500 => "Internal Server Error",
        _ => "OK",
    };
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
        body.as_bytes().len(),
        body
    )?;
    Ok(())
}

fn daemon_stats_json(state: &DaemonState) -> String {
    format!(
        "{{\"ok\":true,\"preparedComponents\":{},\"reusableInstances\":{},\"activeInvocations\":{},\"maxConcurrentInvocations\":{},\"totalInvocations\":{},\"failedInvocations\":{},\"rejectedInvocations\":{},\"avgInvokeMs\":{:.3}}}",
        state.runtime.prepared_component_count(),
        state.runtime.reusable_instance_count(),
        state.admission.active(),
        state.admission.max(),
        state.metrics.total_invocations(),
        state.metrics.failed_invocations(),
        state.metrics.rejected_invocations(),
        state.metrics.avg_invoke_ms(),
    )
}

fn daemon_metrics_text(state: &DaemonState) -> String {
    format!(
        concat!(
            "# TYPE wasmplane_host_prepared_components gauge\n",
            "wasmplane_host_prepared_components {}\n",
            "# TYPE wasmplane_host_reusable_instances gauge\n",
            "wasmplane_host_reusable_instances {}\n",
            "# TYPE wasmplane_host_active_invocations gauge\n",
            "wasmplane_host_active_invocations {}\n",
            "# TYPE wasmplane_host_max_concurrent_invocations gauge\n",
            "wasmplane_host_max_concurrent_invocations {}\n",
            "# TYPE wasmplane_host_invocations_total counter\n",
            "wasmplane_host_invocations_total{{status=\"ok\"}} {}\n",
            "wasmplane_host_invocations_total{{status=\"error\"}} {}\n",
            "# TYPE wasmplane_host_invocations_rejected_total counter\n",
            "wasmplane_host_invocations_rejected_total {}\n",
            "# TYPE wasmplane_host_invocation_duration_seconds summary\n",
            "wasmplane_host_invocation_duration_seconds_count {}\n",
            "wasmplane_host_invocation_duration_seconds_sum {:.6}\n",
        ),
        state.runtime.prepared_component_count(),
        state.runtime.reusable_instance_count(),
        state.admission.active(),
        state.admission.max(),
        state.metrics.ok_invocations(),
        state.metrics.failed_invocations(),
        state.metrics.rejected_invocations(),
        state.metrics.total_invocations(),
        state.metrics.total_duration_seconds(),
    )
}

fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

fn parse_u64(value: &str, name: &str) -> Result<u64> {
    let value = value
        .parse::<u64>()
        .with_context(|| format!("{name} must be a positive integer"))?;
    if value == 0 {
        bail!("{name} must be a positive integer");
    }
    Ok(value)
}

fn parse_u32(value: &str, name: &str) -> Result<u32> {
    let value = value
        .parse::<u32>()
        .with_context(|| format!("{name} must be a positive integer"))?;
    if value == 0 {
        bail!("{name} must be a positive integer");
    }
    Ok(value)
}

fn parse_u16(value: &str, name: &str) -> Result<u16> {
    let value = value
        .parse::<u16>()
        .with_context(|| format!("{name} must be a positive integer"))?;
    if value == 0 {
        bail!("{name} must be a positive integer");
    }
    Ok(value)
}

fn parse_instance_reuse_contract(value: &str) -> Result<InstanceReuseContract> {
    match value {
        "disabled" => Ok(InstanceReuseContract::Disabled),
        "stateless-v1" => Ok(InstanceReuseContract::StatelessV1),
        "guest-reset-v1" => Ok(InstanceReuseContract::GuestResetV1),
        _ => bail!(
            "--instance-reuse-contract must be one of: disabled, stateless-v1, guest-reset-v1"
        ),
    }
}

fn parse_usize(value: &str, name: &str) -> Result<usize> {
    let value = value
        .parse::<usize>()
        .with_context(|| format!("{name} must be a positive integer"))?;
    if value == 0 {
        bail!("{name} must be a positive integer");
    }
    Ok(value)
}

fn parse_headers_arg(value: &str) -> Result<Vec<(String, String)>> {
    let json: Value = serde_json::from_str(value).context("--headers must be valid JSON")?;
    parse_headers_value(&json)
}

fn parse_headers_value(json: &Value) -> Result<Vec<(String, String)>> {
    let Value::Array(items) = json else {
        bail!("headers must be a JSON array");
    };
    items
        .iter()
        .map(|item| {
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .context("headers entries must include name")?;
            let value = item
                .get("value")
                .and_then(Value::as_str)
                .context("headers entries must include value")?;
            Ok((name.to_string(), value.to_string()))
        })
        .collect()
}

fn parse_limits_value(value: &Value) -> Result<InvocationLimits> {
    let object = value.as_object().context("limits must be a JSON object")?;
    let mut limits = InvocationLimits::default();
    if let Some(value) = object.get("wallMs") {
        limits.wall_ms = Some(json_u64(value, "limits.wallMs")?);
    }
    if let Some(value) = object.get("cpuMs") {
        limits.cpu_ms = Some(json_u64(value, "limits.cpuMs")?);
    }
    if let Some(value) = object.get("memoryMb") {
        limits.memory_mb = Some(json_u64(value, "limits.memoryMb")?);
    }
    if let Some(value) = object.get("requestBytes") {
        limits.request_bytes = Some(json_usize(value, "limits.requestBytes")?);
    }
    if let Some(value) = object.get("responseBytes") {
        limits.response_bytes = Some(json_usize(value, "limits.responseBytes")?);
    }
    if let Some(value) = object.get("subrequests") {
        limits.subrequests = Some(json_u32(value, "limits.subrequests")?);
    }
    if let Some(value) = object.get("hostCalls") {
        limits.host_calls = Some(json_u32(value, "limits.hostCalls")?);
    }
    Ok(limits)
}

fn json_u64(value: &Value, name: &str) -> Result<u64> {
    let value = value
        .as_u64()
        .with_context(|| format!("{name} must be a positive integer"))?;
    if value == 0 {
        bail!("{name} must be a positive integer");
    }
    Ok(value)
}

fn json_u32(value: &Value, name: &str) -> Result<u32> {
    let value = json_u64(value, name)?;
    u32::try_from(value).with_context(|| format!("{name} is too large"))
}

fn json_usize(value: &Value, name: &str) -> Result<usize> {
    let value = json_u64(value, name)?;
    usize::try_from(value).with_context(|| format!("{name} is too large"))
}

fn mb_to_usize(value: u64) -> usize {
    let bytes = value.saturating_mul(1024).saturating_mul(1024);
    usize::try_from(bytes).unwrap_or(usize::MAX)
}

fn parse_host_policy(value: &str) -> Result<HostPolicy> {
    let json: Value = serde_json::from_str(value).context("--capabilities must be valid JSON")?;
    if !json.is_object() {
        bail!("--capabilities must be a JSON object");
    }
    reject_privileged_capability(&json, "arbitraryFilesystem")?;
    reject_privileged_capability(&json, "arbitrarySockets")?;
    reject_privileged_capability(&json, "processSpawn")?;

    let outbound_http = json
        .get("outboundHttp")
        .map(parse_outbound_http_policy)
        .transpose()?
        .unwrap_or_else(OutboundHttpPolicy::disabled);
    let kv_bindings = parse_kv_bindings(json.get("kv"))?;
    let secret_bindings = parse_secret_bindings(json.get("secrets"))?;

    Ok(HostPolicy::with_bindings(
        outbound_http,
        kv_bindings,
        secret_bindings,
    ))
}

fn reject_privileged_capability(json: &Value, field: &str) -> Result<()> {
    if json.get(field).and_then(Value::as_bool).unwrap_or(false) {
        bail!("{field} is not allowed for workers");
    }
    Ok(())
}

fn parse_outbound_http_policy(value: &Value) -> Result<OutboundHttpPolicy> {
    if !value.is_object() {
        bail!("capabilities.outboundHttp must be an object");
    }
    let enabled = value
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let allow = match value.get("allow") {
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(str::to_string)
                    .context("capabilities.outboundHttp.allow entries must be strings")
            })
            .collect::<Result<Vec<_>>>()?,
        None => Vec::new(),
        _ => bail!("capabilities.outboundHttp.allow must be an array"),
    };
    if !enabled && !allow.is_empty() {
        bail!("outbound allowlist requires outboundHttp.enabled");
    }
    if enabled {
        Ok(OutboundHttpPolicy::enabled(allow))
    } else {
        Ok(OutboundHttpPolicy::disabled())
    }
}

fn parse_kv_bindings(value: Option<&Value>) -> Result<Vec<KvBindingPolicy>> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let Value::Array(items) = value else {
        bail!("capabilities.kv must be an array");
    };
    items
        .iter()
        .map(|item| {
            let binding = item
                .get("binding")
                .and_then(Value::as_str)
                .context("capabilities.kv entries must include binding")?;
            let namespace_id = item
                .get("namespaceId")
                .and_then(Value::as_str)
                .context("capabilities.kv entries must include namespaceId")?;
            Ok(KvBindingPolicy::new(binding, namespace_id))
        })
        .collect()
}

fn parse_secret_bindings(value: Option<&Value>) -> Result<Vec<SecretBindingPolicy>> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let Value::Array(items) = value else {
        bail!("capabilities.secrets must be an array");
    };
    items
        .iter()
        .map(|item| {
            let binding = item
                .get("binding")
                .and_then(Value::as_str)
                .context("capabilities.secrets entries must include binding")?;
            let secret_id = item
                .get("secretId")
                .and_then(Value::as_str)
                .context("capabilities.secrets entries must include secretId")?;
            let value = item.get("value").and_then(Value::as_str);
            Ok(match value {
                Some(value) => SecretBindingPolicy::with_value(binding, secret_id, value),
                None => SecretBindingPolicy::new(binding, secret_id),
            })
        })
        .collect()
}

fn print_usage() {
    eprintln!("usage:");
    eprintln!(
        "  wasmplane-wasip3-host compile --component <component.wasm> --out <component.cwasm>"
    );
    eprintln!(
        "  wasmplane-wasip3-host invoke (--component <component.wasm> | --precompiled <component.cwasm>) --method <METHOD> --uri <URI> [--headers <JSON>] [--body <TEXT>] [--wall-ms <MS>] [--cpu-ms <MS>] [--memory-mb <MB>] [--request-bytes <BYTES>] [--response-bytes <BYTES>] [--subrequests <COUNT>] [--host-calls <COUNT>] [--capabilities <JSON>] [--kv-store-dir <DIR>]"
    );
    eprintln!(
        "  wasmplane-wasip3-host serve [--host <HOST>] [--port <PORT>] [--kv-store-dir <DIR>] [--max-prepared-components <COUNT>] [--max-concurrent-invocations <COUNT>] [--experimental-instance-reuse <COUNT>] [--instance-reuse-contract <disabled|stateless-v1|guest-reset-v1>] [--pooling-total-component-instances <COUNT>] [--pooling-memory-mb <MB>]"
    );
}

fn json_escape(value: &str) -> String {
    let encoded = serde_json::to_string(value).expect("string JSON encoding should not fail");
    encoded[1..encoded.len() - 1].to_string()
}

fn headers_json(headers: &[(String, String)]) -> String {
    let items = headers
        .iter()
        .map(|(name, value)| {
            format!(
                "{{\"name\":\"{}\",\"value\":\"{}\"}}",
                json_escape(name),
                json_escape(value)
            )
        })
        .collect::<Vec<_>>();
    format!("[{}]", items.join(","))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_invoke_args_accepts_runtime_limits_and_capabilities() {
        let capabilities = r#"{
            "outboundHttp": { "enabled": true, "allow": ["https://api.example.dev/"] },
            "kv": [{ "binding": "KV", "namespaceId": "kv_main" }],
            "secrets": [{ "binding": "API_KEY", "secretId": "sec_api_key", "value": "super-secret" }],
            "arbitraryFilesystem": false,
            "arbitrarySockets": false,
            "processSpawn": false
        }"#;
        let kv_store_dir = std::env::temp_dir().join("wasmplane-cli-kv-store");
        let mut args = vec![
            "--component",
            "/tmp/worker.component.wasm",
            "--method",
            "POST",
            "--uri",
            "https://worker.example.dev/",
            "--headers",
            r#"[{"name":"x-upstream-url","value":"http://127.0.0.1:3000/probe"}]"#,
            "--body",
            "payload",
            "--wall-ms",
            "1000",
            "--cpu-ms",
            "50",
            "--memory-mb",
            "64",
            "--request-bytes",
            "1048576",
            "--response-bytes",
            "1048576",
            "--subrequests",
            "20",
            "--host-calls",
            "100",
            "--capabilities",
            capabilities,
            "--kv-store-dir",
            kv_store_dir.to_str().expect("utf8 kv store path"),
        ]
        .into_iter()
        .map(String::from);

        let parsed = parse_invoke_args(&mut args).expect("invoke args");

        assert_eq!(
            parsed.source,
            InvokeSource::Component(PathBuf::from("/tmp/worker.component.wasm"))
        );
        assert_eq!(parsed.method, "POST");
        assert_eq!(parsed.uri, "https://worker.example.dev/");
        assert_eq!(
            parsed.headers,
            vec![(
                "x-upstream-url".to_string(),
                "http://127.0.0.1:3000/probe".to_string()
            )]
        );
        assert_eq!(parsed.body, "payload");
        assert_eq!(parsed.limits.wall_ms, Some(1000));
        assert_eq!(parsed.limits.cpu_ms, Some(50));
        assert_eq!(parsed.limits.memory_mb, Some(64));
        assert_eq!(parsed.limits.request_bytes, Some(1048576));
        assert_eq!(parsed.limits.response_bytes, Some(1048576));
        assert_eq!(parsed.limits.subrequests, Some(20));
        assert_eq!(parsed.limits.host_calls, Some(100));
        assert!(
            parsed
                .policy
                .allows_outbound_uri("https://api.example.dev/users")
        );
        assert_eq!(
            parsed.policy.kv_namespace_for_binding("KV"),
            Some("kv_main")
        );
        assert!(parsed.policy.secret_for_binding("API_KEY").is_some());
        assert_eq!(parsed.kv_store_dir, Some(kv_store_dir));
    }

    #[test]
    fn parse_invoke_args_accepts_precompiled_component() {
        let mut args = vec![
            "--precompiled",
            "/tmp/worker.component.cwasm",
            "--method",
            "GET",
            "--uri",
            "https://worker.example.dev/",
        ]
        .into_iter()
        .map(String::from);

        let parsed = parse_invoke_args(&mut args).expect("invoke args");

        assert_eq!(
            parsed.source,
            InvokeSource::Precompiled(PathBuf::from("/tmp/worker.component.cwasm"))
        );
        assert_eq!(parsed.method, "GET");
        assert_eq!(parsed.uri, "https://worker.example.dev/");
    }

    #[test]
    fn parse_serve_args_accepts_host_port_and_kv_store() {
        let kv_store_dir = std::env::temp_dir().join("wasmplane-daemon-kv-store");
        let mut args = vec![
            "--host",
            "127.0.0.1",
            "--port",
            "8790",
            "--kv-store-dir",
            kv_store_dir.to_str().expect("utf8 kv store path"),
        ]
        .into_iter()
        .map(String::from);

        let parsed = parse_serve_args(&mut args).expect("serve args");

        assert_eq!(
            parsed,
            ServeArgs {
                host: "127.0.0.1".to_string(),
                port: 8790,
                kv_store_dir: Some(kv_store_dir),
                runtime_options: Wasip3RuntimeOptions::default(),
                max_concurrent_invocations: DEFAULT_MAX_CONCURRENT_INVOCATIONS,
            }
        );
    }

    #[test]
    fn parse_serve_args_accepts_pooling_controls() {
        let mut args = vec![
            "--max-prepared-components",
            "512",
            "--max-concurrent-invocations",
            "64",
            "--pooling-total-component-instances",
            "64",
            "--pooling-memory-mb",
            "32",
            "--pooling-total-core-instances",
            "256",
            "--pooling-total-memories",
            "64",
            "--pooling-total-tables",
            "128",
            "--pooling-table-elements",
            "4096",
            "--pooling-component-instance-mb",
            "2",
            "--pooling-core-instance-mb",
            "3",
            "--experimental-instance-reuse",
            "2",
            "--instance-reuse-contract",
            "stateless-v1",
        ]
        .into_iter()
        .map(String::from);

        let parsed = parse_serve_args(&mut args).expect("serve args");

        assert_eq!(parsed.runtime_options.max_prepared_components, 512);
        assert_eq!(
            parsed.runtime_options.max_reusable_instances_per_component,
            2
        );
        assert_eq!(
            parsed.runtime_options.instance_reuse_contract,
            InstanceReuseContract::StatelessV1
        );
        assert_eq!(parsed.max_concurrent_invocations, 64);
        assert_eq!(
            parsed.runtime_options.pooling,
            Some(Wasip3PoolingConfig {
                total_component_instances: 64,
                total_core_instances: 256,
                total_memories: 64,
                total_tables: 128,
                max_memory_size: mb_to_usize(32),
                table_elements: 4096,
                max_component_instance_size: mb_to_usize(2),
                max_core_instance_size: mb_to_usize(3),
            })
        );
    }

    #[test]
    fn parse_serve_args_rejects_unknown_instance_reuse_contract() {
        let mut args = vec!["--instance-reuse-contract", "reset-export"]
            .into_iter()
            .map(String::from);

        let error = parse_serve_args(&mut args).expect_err("unknown contract should fail");

        assert!(format!("{error:?}").contains(
            "--instance-reuse-contract must be one of: disabled, stateless-v1, guest-reset-v1"
        ));
    }

    #[test]
    fn parse_serve_args_accepts_guest_reset_instance_reuse_contract() {
        let mut args = vec!["--instance-reuse-contract", "guest-reset-v1"]
            .into_iter()
            .map(String::from);

        let parsed = parse_serve_args(&mut args).expect("serve args");

        assert_eq!(
            parsed.runtime_options.instance_reuse_contract,
            InstanceReuseContract::GuestResetV1
        );
    }

    #[test]
    fn parse_compile_args_accepts_pooling_controls() {
        let mut args = vec![
            "--component",
            "/tmp/worker.component.wasm",
            "--out",
            "/tmp/worker.component.cwasm",
            "--pooling-total-component-instances",
            "16",
            "--pooling-memory-mb",
            "64",
        ]
        .into_iter()
        .map(String::from);

        let parsed = parse_compile_args(&mut args).expect("compile args");

        assert_eq!(
            parsed.component,
            PathBuf::from("/tmp/worker.component.wasm")
        );
        assert_eq!(parsed.output, PathBuf::from("/tmp/worker.component.cwasm"));
        assert_eq!(
            parsed.pooling,
            Some(Wasip3PoolingConfig::for_component_slots(16, 64))
        );
    }

    #[test]
    fn parse_daemon_invoke_accepts_precompiled_payload() {
        let payload: Value = serde_json::json!({
            "precompiled": "/tmp/worker.component.cwasm",
            "method": "POST",
            "uri": "https://worker.example.dev/",
            "headers": [{ "name": "x-test", "value": "yes" }],
            "body": "payload",
            "limits": {
                "wallMs": 1000,
                "cpuMs": 50,
                "memoryMb": 64,
                "requestBytes": 1024,
                "responseBytes": 2048,
                "subrequests": 2,
                "hostCalls": 10
            },
            "capabilities": {
                "outboundHttp": { "enabled": true, "allow": ["https://api.example.dev/"] },
                "kv": [{ "binding": "KV", "namespaceId": "kv_main" }],
                "secrets": [],
                "arbitraryFilesystem": false,
                "arbitrarySockets": false,
                "processSpawn": false
            }
        });

        let parsed = parse_daemon_invoke(&payload).expect("daemon invoke");

        assert_eq!(
            parsed.source,
            InvokeSource::Precompiled(PathBuf::from("/tmp/worker.component.cwasm"))
        );
        assert_eq!(parsed.method, "POST");
        assert_eq!(parsed.uri, "https://worker.example.dev/");
        assert_eq!(
            parsed.headers,
            vec![("x-test".to_string(), "yes".to_string())]
        );
        assert_eq!(parsed.body, "payload");
        assert_eq!(parsed.limits.wall_ms, Some(1000));
        assert_eq!(parsed.limits.cpu_ms, Some(50));
        assert_eq!(parsed.limits.memory_mb, Some(64));
        assert_eq!(parsed.limits.request_bytes, Some(1024));
        assert_eq!(parsed.limits.response_bytes, Some(2048));
        assert_eq!(parsed.limits.subrequests, Some(2));
        assert_eq!(parsed.limits.host_calls, Some(10));
        assert!(
            parsed
                .policy
                .allows_outbound_uri("https://api.example.dev/users")
        );
        assert_eq!(
            parsed.policy.kv_namespace_for_binding("KV"),
            Some("kv_main")
        );
    }

    #[test]
    fn parse_invoke_args_rejects_ambiguous_component_source() {
        let mut args = vec![
            "--component",
            "/tmp/worker.component.wasm",
            "--precompiled",
            "/tmp/worker.component.cwasm",
            "--method",
            "GET",
            "--uri",
            "https://worker.example.dev/",
        ]
        .into_iter()
        .map(String::from);

        let error = parse_invoke_args(&mut args).expect_err("ambiguous source should fail");

        assert!(format!("{error:?}").contains("expected exactly one"));
    }

    #[test]
    fn invoke_output_json_escapes_response_body_control_chars() {
        let output = format!(
            "{{\"status\":200,\"headers\":{},\"body\":\"{}\"}}",
            headers_json(&[("x-message".to_string(), "quote: \"".to_string())]),
            json_escape("line 1\nline 2\r\nquote: \"")
        );

        let parsed: Value = serde_json::from_str(&output).expect("valid response JSON");

        assert_eq!(parsed["status"], 200);
        assert_eq!(parsed["headers"][0]["value"], "quote: \"");
        assert_eq!(parsed["body"], "line 1\nline 2\r\nquote: \"");
    }

    #[test]
    fn parse_host_policy_rejects_privileged_capabilities() {
        let error = parse_host_policy(
            r#"{
                "outboundHttp": { "enabled": false, "allow": [] },
                "kv": [],
                "secrets": [],
                "arbitraryFilesystem": false,
                "arbitrarySockets": true,
                "processSpawn": false
            }"#,
        )
        .expect_err("privileged socket access should be denied");

        assert!(format!("{error:?}").contains("arbitrarySockets is not allowed"));
    }

    #[test]
    fn daemon_admission_limiter_rejects_when_full() {
        let limiter = Arc::new(AdmissionLimiter::new(1));
        let first = limiter.try_acquire().expect("first permit");

        assert!(limiter.try_acquire().is_none());
        assert_eq!(limiter.active(), 1);
        assert_eq!(limiter.max(), 1);

        drop(first);

        assert_eq!(limiter.active(), 0);
        assert!(limiter.try_acquire().is_some());
    }

    #[test]
    fn daemon_stats_and_metrics_report_runtime_pressure() {
        let state = DaemonState::new(Arc::new(Wasip3Runtime::new().expect("runtime")), None, 2);
        let _permit = state.admission.try_acquire().expect("permit");
        state
            .metrics
            .record_invoke(std::time::Duration::from_millis(25), true);
        state
            .metrics
            .record_invoke(std::time::Duration::from_millis(10), false);
        state.metrics.record_rejected();

        let stats: Value = serde_json::from_str(&daemon_stats_json(&state)).expect("stats json");
        assert_eq!(stats["preparedComponents"], 0);
        assert_eq!(stats["reusableInstances"], 0);
        assert_eq!(stats["activeInvocations"], 1);
        assert_eq!(stats["maxConcurrentInvocations"], 2);
        assert_eq!(stats["totalInvocations"], 2);
        assert_eq!(stats["failedInvocations"], 1);
        assert_eq!(stats["rejectedInvocations"], 1);
        assert!((stats["avgInvokeMs"].as_f64().expect("avg latency") - 17.5).abs() < f64::EPSILON);

        let metrics = daemon_metrics_text(&state);
        assert!(metrics.contains("wasmplane_host_prepared_components 0"));
        assert!(metrics.contains("wasmplane_host_reusable_instances 0"));
        assert!(metrics.contains("wasmplane_host_active_invocations 1"));
        assert!(metrics.contains("wasmplane_host_max_concurrent_invocations 2"));
        assert!(metrics.contains("wasmplane_host_invocations_total{status=\"ok\"} 1"));
        assert!(metrics.contains("wasmplane_host_invocations_total{status=\"error\"} 1"));
        assert!(metrics.contains("wasmplane_host_invocations_rejected_total 1"));
        assert!(metrics.contains("wasmplane_host_invocation_duration_seconds_count 2"));
        assert!(metrics.contains("wasmplane_host_invocation_duration_seconds_sum 0.035"));
    }
}
