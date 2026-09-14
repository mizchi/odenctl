//! OTLP/HTTP JSON transport shared by traces, logs and cumulative metrics.
//! One owned worker and one bounded queue per runtime; no unbounded retry queue.
use super::*;
pub(super) enum Record {
    Span(Value),
    Log(Value),
}
pub(super) enum Message {
    Record(Record),
    Flush(tokio::sync::oneshot::Sender<()>),
}
pub(super) fn start(
    config: &TelemetryConfig,
    state: Arc<State>,
) -> Result<mpsc::SyncSender<Message>> {
    let mut headers = reqwest::header::HeaderMap::new();
    if let Some(name) = &config.headers_env {
        let values = std::env::var(name)
            .map_err(|_| anyhow::anyhow!("missing telemetry headers variable {name}"))?;
        for entry in values.split(',').filter(|s| !s.trim().is_empty()) {
            let (key, value) = entry
                .split_once('=')
                .ok_or_else(|| anyhow::anyhow!("invalid telemetry header"))?;
            let name = reqwest::header::HeaderName::from_bytes(key.trim().as_bytes())?;
            ensure!(
                !matches!(
                    name.as_str(),
                    "host" | "content-length" | "transfer-encoding"
                ),
                "invalid telemetry transport header"
            );
            let mut value = reqwest::header::HeaderValue::from_str(value.trim())?;
            value.set_sensitive(true);
            headers.insert(name, value);
        }
    }
    let (tx, rx) = mpsc::sync_channel(config.queue_capacity);
    let config = config.clone();
    std::thread::Builder::new().name("oden-telemetry".into()).spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_millis(config.export_timeout_ms)).default_headers(headers).build().unwrap();
        let resource = json!({"attributes": [
            {"key":"service.name", "value":{"stringValue":config.service_name}},
            {"key":"service.instance.id", "value":{"stringValue":id(8)}},
            {"key":"telemetry.sdk.name", "value":{"stringValue":"oden"}},
            {"key":"telemetry.sdk.version", "value":{"stringValue":env!("CARGO_PKG_VERSION")}}
        ]});
        let mut spans = Vec::new(); let mut logs = Vec::new();
        let mut next = Instant::now() + Duration::from_millis(config.interval_ms);
        loop {
            let message = rx.recv_timeout(next.saturating_duration_since(Instant::now()));
            let mut flush = None;
            let mut disconnected = false;
            match message {
                Ok(Message::Record(Record::Span(span))) => spans.push(span),
                Ok(Message::Record(Record::Log(log))) => logs.push(log),
                Ok(Message::Flush(done)) => flush = Some(done),
                Err(mpsc::RecvTimeoutError::Disconnected) => disconnected = true,
                Err(mpsc::RecvTimeoutError::Timeout) => {},
            }
            let periodic = Instant::now() >= next || flush.is_some() || disconnected;
            if periodic || spans.len() + logs.len() >= config.batch_size {
                runtime.block_on(async {
                    let scope = json!({"name":"oden.runtime", "version":env!("CARGO_PKG_VERSION")});
                    if !spans.is_empty() {
                        send(&client, &config, &state, "traces", json!({"resourceSpans":[{"resource":resource,"scopeSpans":[{"scope":scope,"spans":std::mem::take(&mut spans)}]}]})).await;
                    }
                    if !logs.is_empty() {
                        send(&client, &config, &state, "logs", json!({"resourceLogs":[{"resource":resource,"scopeLogs":[{"scope":scope,"logRecords":std::mem::take(&mut logs)}]}]})).await;
                    }
                    if periodic {
                        send(&client, &config, &state, "metrics", json!({"resourceMetrics":[{"resource":resource,"scopeMetrics":[{"scope":scope,"metrics":metrics(&state)}]}]})).await;
                    }
                });
                if periodic { next = Instant::now() + Duration::from_millis(config.interval_ms); }
            }
            if let Some(done) = flush { let _ = done.send(()); }
            if disconnected { break; }
        }
    })?;
    Ok(tx)
}
async fn send(
    client: &reqwest::Client,
    config: &TelemetryConfig,
    state: &State,
    signal: &str,
    payload: Value,
) {
    let url = format!(
        "{}/v1/{signal}",
        config.endpoint.as_ref().unwrap().trim_end_matches('/')
    );
    let result = client.post(url).json(&payload).send().await;
    if !result.is_ok_and(|r| r.status().is_success()) {
        state.counts.export_errors.fetch_add(1, Ordering::Relaxed);
    }
}
fn metrics(state: &State) -> Vec<Value> {
    let snapshot = state.snapshot();
    let time = now().to_string();
    let mut metrics = Vec::new();
    for (name, count, gauge) in [
        ("oden.operations", snapshot.completed, false),
        ("oden.errors", snapshot.errors, false),
        ("oden.cancelled", snapshot.cancelled, false),
        ("oden.telemetry.dropped", snapshot.dropped, false),
        (
            "oden.telemetry.export_errors",
            snapshot.export_errors,
            false,
        ),
        ("oden.active_operations", snapshot.active, true),
        ("oden.stores", snapshot.stores, true),
        ("oden.queue.depth", snapshot.queued, true),
        ("oden.requests.rejected", snapshot.rejected, false),
    ] {
        let point = json!({"startTimeUnixNano":state.started.to_string(),"timeUnixNano":time,"asInt":count.to_string()});
        metrics.push(if gauge { json!({"name":name,"unit":"{operation}","gauge":{"dataPoints":[point]}}) }
            else { json!({"name":name,"unit":"{operation}","sum":{"aggregationTemporality":2,"isMonotonic":true,"dataPoints":[point]}}) });
    }
    let mut histograms: BTreeMap<&str, Vec<Value>> = BTreeMap::new();
    for ((group, method, status), histogram) in state.histograms.lock().unwrap().iter() {
        let name = match *group {
            "http.server" => "http.server.request.duration",
            "http.client" => "http.client.request.duration",
            "queue" => "oden.queue.wait.duration",
            _ => "oden.operation.duration",
        };
        let mut attrs = vec![("oden.operation".into(), json!(group))];
        if !method.is_empty() {
            attrs.push(("http.request.method".into(), json!(method)));
        }
        if *group == "http.server" {
            attrs.push(("url.scheme".into(), json!("http")));
        }
        if *status != 0 {
            attrs.push(("http.response.status_code".into(), json!(status)));
        }
        histograms.entry(name).or_default().push(json!({"attributes":attributes(attrs.into_iter()),"startTimeUnixNano":state.started.to_string(),"timeUnixNano":time,"count":histogram.count.to_string(),"sum":histogram.sum,"explicitBounds":BOUNDS,"bucketCounts":histogram.buckets.map(|n| n.to_string())}));
    }
    for (name, points) in histograms {
        metrics.push(json!({"name":name,"unit":"s","histogram":{"aggregationTemporality":2,"dataPoints":points}}));
    }
    metrics
}
