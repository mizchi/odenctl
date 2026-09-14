use oden_runtime_core::telemetry::{Telemetry, TelemetryConfig, TraceContext};

#[test]
fn contexts_are_explicit_and_spans_end_once() {
    let telemetry = Telemetry::new(TelemetryConfig::default()).unwrap();
    let a = telemetry.span("request-a", None);
    let b = telemetry.span("request-b", None);
    let child = telemetry.span("child-a", Some(&a.context()));
    assert_eq!(child.context().trace_id, a.context().trace_id);
    assert_ne!(child.context().trace_id, b.context().trace_id);
    child.finish("ok");
    child.finish("error");
    drop(child);
    assert_eq!(telemetry.snapshot().completed, 1);
    assert_eq!(telemetry.snapshot().errors, 0);
}

#[test]
fn validates_trace_context_and_preserves_unsampled_parents() {
    assert!(
        TraceContext::parse(
            "00-00000000000000000000000000000000-1234567890123456-01",
            ""
        )
        .is_none()
    );
    assert!(
        TraceContext::parse(
            "00-01234567890123456789012345678901-0000000000000000-01",
            ""
        )
        .is_none()
    );
    let parent = TraceContext::parse(
        "00-01234567890123456789012345678901-1234567890123456-00",
        "vendor=value",
    )
    .unwrap();
    let telemetry = Telemetry::new(TelemetryConfig::default()).unwrap();
    let child = telemetry.span("child", Some(&parent));
    assert_eq!(child.context().flags, 0);
    assert_eq!(child.context().tracestate, "vendor=value");
    assert!(child.context().traceparent().ends_with("-00"));
}

#[test]
fn dropped_spans_are_accounted_without_guest_cleanup() {
    let telemetry = Telemetry::new(TelemetryConfig::default()).unwrap();
    drop(telemetry.span("cancelled", None));
    assert_eq!(telemetry.snapshot().completed, 1);
    assert_eq!(telemetry.snapshot().cancelled, 1);
}

#[tokio::test]
async fn commands_record_compile_instantiate_and_run_and_release_the_store() {
    use oden_runtime_core::{config::RuntimeConfig, runtime::Runtime};
    let runtime = Runtime::new(RuntimeConfig::default()).unwrap();
    let command = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/minimal-command/command.wat");
    assert_eq!(runtime.run(&command, &[]).await.unwrap(), 0);
    let snapshot = runtime.telemetry.snapshot();
    assert_eq!(snapshot.completed, 3);
    assert_eq!(snapshot.errors, 0);
    assert_eq!(snapshot.active, 0);
    assert_eq!(snapshot.stores, 0);
}

#[tokio::test]
async fn body_completion_and_cancellation_have_distinct_lifetimes() {
    use bytes::Bytes;
    use futures::StreamExt;
    use http_body::Frame;
    use http_body_util::{BodyExt, Full, StreamBody};
    use oden_runtime_core::telemetry::body::TrackedBody;
    let telemetry = Telemetry::new(TelemetryConfig::default()).unwrap();
    let body = TrackedBody::new(
        Full::new(Bytes::from_static(b"hello")),
        telemetry.span("complete", None),
        200,
    );
    assert_eq!(telemetry.snapshot().completed, 0);
    assert_eq!(body.collect().await.unwrap().to_bytes(), "hello");
    let stream = futures::stream::iter([Ok::<_, std::convert::Infallible>(Frame::data(
        Bytes::from_static(b"first"),
    ))])
    .chain(futures::stream::pending());
    let mut body = TrackedBody::new(
        StreamBody::new(stream),
        telemetry.span("cut-short", None),
        200,
    );
    body.frame().await.unwrap().unwrap();
    assert_eq!(telemetry.snapshot().completed, 1);
    drop(body);
    assert_eq!(telemetry.snapshot().completed, 2);
    assert_eq!(telemetry.snapshot().cancelled, 1);
    assert_eq!(telemetry.snapshot().active, 0);
}

#[tokio::test]
async fn collector_outage_and_queue_overflow_do_not_block_recording() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let telemetry = Telemetry::new(TelemetryConfig {
        endpoint: Some(format!("http://{}", listener.local_addr().unwrap())),
        queue_capacity: 4,
        batch_size: 1,
        interval_ms: 10,
        export_timeout_ms: 20,
        ..Default::default()
    })
    .unwrap();
    for _ in 0..2000 {
        telemetry.span("operation", None).finish("ok");
    }
    assert_eq!(telemetry.snapshot().completed, 2000);
    assert!(telemetry.snapshot().dropped > 0);
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    assert!(telemetry.snapshot().export_errors > 0);
}
