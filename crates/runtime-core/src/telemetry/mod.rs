//! Bounded host telemetry. Context is passed explicitly; export never runs on a guest task.
pub mod body;
mod context;
mod export;
pub(crate) mod guest;
use anyhow::{Result, ensure};
pub use context::TraceContext;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct TelemetryConfig {
    pub enabled: bool,
    /// OTLP/HTTP base URL. No exporter is started when absent.
    pub endpoint: Option<String>,
    pub service_name: String,
    pub queue_capacity: usize,
    pub batch_size: usize,
    pub interval_ms: u64,
    pub export_timeout_ms: u64,
    pub sample_rate: f64,
    /// Read credentials from a host environment variable, never a guest grant.
    pub headers_env: Option<String>,
}
impl Default for TelemetryConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            endpoint: None,
            service_name: "wasmplane".into(),
            queue_capacity: 2048,
            batch_size: 128,
            interval_ms: 1000,
            export_timeout_ms: 1000,
            sample_rate: 1.0,
            headers_env: None,
        }
    }
}
impl TelemetryConfig {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            (1..=65536).contains(&self.queue_capacity),
            "telemetry queue_capacity must be 1..65536"
        );
        ensure!(
            (1..=1024).contains(&self.batch_size) && self.batch_size <= self.queue_capacity,
            "invalid telemetry batch_size"
        );
        ensure!(
            (10..=60000).contains(&self.interval_ms),
            "invalid telemetry interval_ms"
        );
        ensure!(
            (1..=10000).contains(&self.export_timeout_ms),
            "invalid telemetry export_timeout_ms"
        );
        ensure!(
            self.sample_rate.is_finite() && (0.0..=1.0).contains(&self.sample_rate),
            "invalid telemetry sample_rate"
        );
        ensure!(
            !self.service_name.is_empty() && self.service_name.len() <= 128,
            "invalid telemetry service_name"
        );
        if let Some(endpoint) = &self.endpoint {
            let url = reqwest::Url::parse(endpoint)?;
            ensure!(
                matches!(url.scheme(), "http" | "https")
                    && url.host_str().is_some()
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.query().is_none()
                    && url.fragment().is_none(),
                "invalid telemetry endpoint"
            );
        }
        Ok(())
    }
}

#[derive(Default, Clone, Serialize, Debug)]
pub struct Snapshot {
    pub completed: u64,
    pub errors: u64,
    pub cancelled: u64,
    pub dropped: u64,
    pub export_errors: u64,
    pub active: u64,
    pub stores: u64,
    pub queued: u64,
    pub rejected: u64,
}
#[derive(Default)]
struct Counters {
    completed: AtomicU64,
    errors: AtomicU64,
    cancelled: AtomicU64,
    dropped: AtomicU64,
    export_errors: AtomicU64,
    active: AtomicU64,
    stores: AtomicU64,
    queued: AtomicU64,
    rejected: AtomicU64,
}
const BOUNDS: [f64; 14] = [
    0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1.0, 2.5, 5.0, 7.5, 10.0,
];
#[derive(Default)]
struct Histogram {
    count: u64,
    sum: f64,
    buckets: [u64; 15],
}
struct State {
    counts: Counters,
    // Only runtime-controlled groups are keys. Guest span names never become metric labels.
    histograms: Mutex<BTreeMap<(&'static str, &'static str, u16), Histogram>>,
    started: u64,
}
impl State {
    fn snapshot(&self) -> Snapshot {
        macro_rules! get { ($($n:ident),*) => { Snapshot { $($n: self.counts.$n.load(Ordering::Relaxed)),* } }; }
        get!(
            completed,
            errors,
            cancelled,
            dropped,
            export_errors,
            active,
            stores,
            queued,
            rejected
        )
    }
}
#[derive(Clone)]
pub struct Telemetry(Arc<Inner>);
struct Inner {
    config: TelemetryConfig,
    state: Arc<State>,
    sender: Option<mpsc::SyncSender<export::Message>>,
}
impl Telemetry {
    pub fn new(config: TelemetryConfig) -> Result<Self> {
        config.validate()?;
        let state = Arc::new(State {
            counts: Counters::default(),
            histograms: Mutex::default(),
            started: now(),
        });
        let sender = if config.enabled && config.endpoint.is_some() {
            Some(export::start(&config, state.clone())?)
        } else {
            None
        };
        Ok(Self(Arc::new(Inner {
            config,
            state,
            sender,
        })))
    }
    pub fn snapshot(&self) -> Snapshot {
        self.0.state.snapshot()
    }
    pub fn enabled(&self) -> bool {
        self.0.config.enabled
    }
    pub fn span(&self, name: &str, parent: Option<&TraceContext>) -> Span {
        self.start(name, parent, 1, "guest")
    }
    pub async fn observe<T, E>(
        &self,
        name: &str,
        group: &'static str,
        parent: Option<&TraceContext>,
        work: impl std::future::Future<Output = std::result::Result<T, E>>,
    ) -> std::result::Result<T, E> {
        let span = self.start(name, parent, 1, group);
        let result = work.await;
        span.finish(if result.is_ok() { "ok" } else { "error" });
        result
    }
    pub fn start(
        &self,
        name: &str,
        parent: Option<&TraceContext>,
        kind: u8,
        group: &'static str,
    ) -> Span {
        let trace_id = parent.map(|p| p.trace_id.clone()).unwrap_or_else(|| id(16));
        let sampled = parent.map(|p| p.flags & 1 != 0).unwrap_or_else(|| {
            let value = u64::from_str_radix(&trace_id[..16], 16).unwrap();
            self.0.config.sample_rate >= 1.0
                || (value as f64 / u64::MAX as f64) < self.0.config.sample_rate
        });
        let context = TraceContext {
            trace_id,
            span_id: id(8),
            flags: u8::from(sampled),
            tracestate: parent.map(|p| p.tracestate.clone()).unwrap_or_default(),
        };
        if self.enabled() {
            self.0.state.counts.active.fetch_add(1, Ordering::Relaxed);
        }
        Span {
            telemetry: self.clone(),
            context,
            parent: parent.map(|p| p.span_id.clone()),
            name: truncate(name, 128),
            kind,
            group,
            start: Instant::now(),
            time: now(),
            data: Mutex::new(Some(SpanData {
                attributes: BTreeMap::new(),
                events: vec![],
                links: vec![],
            })),
        }
    }
    pub fn request(&self, headers: &mut hyper::HeaderMap, method: &str) -> Span {
        let parent = TraceContext::from_headers(headers);
        let method = match method {
            "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "CONNECT"
            | "TRACE" => method,
            _ => "_OTHER",
        };
        let span = self.start(method, parent.as_ref(), 2, "http.server");
        span.attribute("http.request.method", json!(method));
        span.attribute("url.scheme", json!("http"));
        span.context.inject(headers);
        span
    }
    pub fn store(&self) -> GaugeGuard {
        self.gauge("stores")
    }
    pub fn queue(&self) -> GaugeGuard {
        self.gauge("queued")
    }
    fn gauge(&self, kind: &'static str) -> GaugeGuard {
        let guard = GaugeGuard {
            telemetry: self.clone(),
            kind,
        };
        if self.enabled() {
            guard.counter().fetch_add(1, Ordering::Relaxed);
        }
        guard
    }
    pub fn reject(&self) {
        if self.enabled() {
            self.0.state.counts.rejected.fetch_add(1, Ordering::Relaxed);
        }
    }
    pub(crate) fn dropped(&self) {
        self.0.state.counts.dropped.fetch_add(1, Ordering::Relaxed);
    }
    pub fn log(
        &self,
        context: Option<&TraceContext>,
        level: &str,
        message: &str,
        attrs: Vec<(String, Value)>,
    ) {
        if !self.enabled() {
            return;
        }
        let (number, text) = match level {
            "trace" => (1, "TRACE"),
            "debug" => (5, "DEBUG"),
            "warn" => (13, "WARN"),
            "error" => (17, "ERROR"),
            _ => (9, "INFO"),
        };
        self.emit(export::Record::Log(json!({ "timeUnixNano": now().to_string(), "observedTimeUnixNano": now().to_string(), "severityNumber": number, "severityText": text, "body": {"stringValue": truncate(message, 4096)}, "traceId": context.map(|c| c.trace_id.as_str()).unwrap_or(""), "spanId": context.map(|c| c.span_id.as_str()).unwrap_or(""), "flags": context.map(|c| c.flags).unwrap_or(0), "attributes": attributes(attrs.into_iter().take(32)) })));
    }
    fn emit(&self, record: export::Record) {
        if let Some(sender) = &self.0.sender {
            if sender.try_send(export::Message::Record(record)).is_err() {
                self.0.state.counts.dropped.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
    /// A bounded barrier; only shutdown/test code waits, never request execution.
    pub async fn flush(&self) -> bool {
        let Some(sender) = &self.0.sender else {
            return true;
        };
        let (tx, rx) = tokio::sync::oneshot::channel();
        if sender.try_send(export::Message::Flush(tx)).is_err() {
            return false;
        }
        tokio::time::timeout(
            Duration::from_millis(self.0.config.export_timeout_ms * 3 + self.0.config.interval_ms),
            rx,
        )
        .await
        .is_ok_and(|r| r.is_ok())
    }
}

pub struct GaugeGuard {
    telemetry: Telemetry,
    kind: &'static str,
}
impl GaugeGuard {
    fn counter(&self) -> &AtomicU64 {
        if self.kind == "stores" {
            &self.telemetry.0.state.counts.stores
        } else {
            &self.telemetry.0.state.counts.queued
        }
    }
}
impl Drop for GaugeGuard {
    fn drop(&mut self) {
        if self.telemetry.enabled() {
            self.counter().fetch_sub(1, Ordering::Relaxed);
        }
    }
}
struct SpanData {
    attributes: BTreeMap<String, Value>,
    events: Vec<Value>,
    links: Vec<Value>,
}
pub struct Span {
    telemetry: Telemetry,
    context: TraceContext,
    parent: Option<String>,
    name: String,
    kind: u8,
    group: &'static str,
    start: Instant,
    time: u64,
    data: Mutex<Option<SpanData>>,
}
impl Span {
    pub fn context(&self) -> TraceContext {
        self.context.clone()
    }
    pub fn attribute(&self, key: &str, value: Value) {
        let value = match value {
            Value::String(v) => json!(truncate(&v, 1024)),
            Value::Bool(_) | Value::Number(_) => value,
            _ => json!("[unsupported]"),
        };
        if let Some(data) = self.data.lock().unwrap().as_mut() {
            if data.attributes.len() < 32 || data.attributes.contains_key(key) {
                data.attributes.insert(truncate(key, 128), value);
            }
        }
    }
    pub fn event(&self, name: &str) {
        if let Some(data) = self.data.lock().unwrap().as_mut() {
            if data.events.len() < 32 {
                data.events
                    .push(json!({"name": truncate(name, 128), "timeUnixNano": now().to_string()}));
            }
        }
    }
    pub fn link(&self, context: &TraceContext) {
        if let Some(data) = self.data.lock().unwrap().as_mut() {
            if data.links.len() < 8 {
                data.links.push(json!({"traceId": context.trace_id, "spanId": context.span_id, "traceState": context.tracestate, "flags": context.flags}));
            }
        }
    }
    pub fn http_status(&self, status: u16) {
        self.attribute("http.response.status_code", json!(status));
    }
    pub fn finish(&self, outcome: &str) {
        let Some(mut data) = self.data.lock().unwrap().take() else {
            return;
        };
        if !self.telemetry.enabled() {
            return;
        }
        let outcome = match outcome {
            "ok" => "ok",
            "cancelled" => "cancelled",
            "timeout" => "timeout",
            "outcome-unknown" => "outcome-unknown",
            _ => "error",
        };
        let state = &self.telemetry.0.state;
        state.counts.active.fetch_sub(1, Ordering::Relaxed);
        state.counts.completed.fetch_add(1, Ordering::Relaxed);
        if outcome == "cancelled" {
            state.counts.cancelled.fetch_add(1, Ordering::Relaxed);
        } else if outcome != "ok" {
            state.counts.errors.fetch_add(1, Ordering::Relaxed);
        }
        if outcome != "ok" && outcome != "cancelled" {
            self.telemetry.log(
                Some(&self.context),
                "error",
                &self.name,
                vec![("error.type".into(), json!(outcome))],
            );
        }
        let duration = self.start.elapsed().as_secs_f64();
        let group = match self.group {
            "http.server" | "http.client" | "queue" | "compile" | "instantiate" | "start"
            | "stop" | "run" | "durable" => self.group,
            _ => "guest",
        };
        {
            let mut histograms = state.histograms.lock().unwrap();
            let method = if group.starts_with("http.") {
                match data
                    .attributes
                    .get("http.request.method")
                    .and_then(Value::as_str)
                {
                    Some("GET") => "GET",
                    Some("POST") => "POST",
                    Some("PUT") => "PUT",
                    Some("PATCH") => "PATCH",
                    Some("DELETE") => "DELETE",
                    Some("HEAD") => "HEAD",
                    Some("OPTIONS") => "OPTIONS",
                    Some("TRACE") => "TRACE",
                    Some("CONNECT") => "CONNECT",
                    _ => "_OTHER",
                }
            } else {
                ""
            };
            let status = data
                .attributes
                .get("http.response.status_code")
                .and_then(Value::as_u64)
                .filter(|n| (100..=599).contains(n))
                .unwrap_or(0) as u16;
            let histogram = histograms.entry((group, method, status)).or_default();
            histogram.count += 1;
            histogram.sum += duration;
            histogram.buckets[BOUNDS.iter().position(|v| duration <= *v).unwrap_or(14)] += 1;
        }
        if self.context.flags & 1 == 0 {
            return;
        }
        data.attributes
            .insert("wasmplane.outcome".into(), json!(outcome));
        if outcome != "ok" {
            data.attributes.insert("error.type".into(), json!(outcome));
        }
        self.telemetry.emit(export::Record::Span(json!({ "traceId": self.context.trace_id, "spanId": self.context.span_id, "traceState": self.context.tracestate, "parentSpanId": self.parent.as_deref().unwrap_or(""), "flags": self.context.flags, "name": self.name, "kind": self.kind, "startTimeUnixNano": self.time.to_string(), "endTimeUnixNano": self.time.saturating_add(self.start.elapsed().as_nanos().min(u64::MAX as u128) as u64).to_string(), "attributes": attributes(data.attributes.into_iter()), "events": data.events, "links": data.links, "status": {"code": if outcome == "ok" {0} else {2}} })));
    }
}
impl Drop for Span {
    fn drop(&mut self) {
        self.finish("cancelled");
    }
}
pub(crate) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .min(u64::MAX as u128) as u64
}
fn id(bytes: usize) -> String {
    let mut data = [0u8; 16];
    getrandom::fill(&mut data[..bytes]).expect("OS randomness for trace IDs");
    data[..bytes].iter().map(|v| format!("{v:02x}")).collect()
}
fn truncate(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}
fn attributes(values: impl Iterator<Item = (String, Value)>) -> Vec<Value> {
    values
        .map(|(key, value)| {
            let value = match value {
                Value::Bool(v) => json!({"boolValue":v}),
                Value::Number(v) if v.is_i64() || v.is_u64() => json!({"intValue":v.to_string()}),
                Value::Number(v) => json!({"doubleValue":v}),
                Value::String(v) => json!({"stringValue":truncate(&v,1024)}),
                _ => json!({"stringValue":"[unsupported]"}),
            };
            json!({"key":truncate(&key,128), "value":value})
        })
        .collect()
}
