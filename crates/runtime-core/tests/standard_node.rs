use std::path::Path;
use wasmplane_runtime_core::node::{HostPolicy, HttpRequestInput, InvocationLimits, Wasip3Runtime};

fn request() -> HttpRequestInput {
    HttpRequestInput {
        method: "GET".into(),
        uri: "http://worker/".into(),
        headers: vec![],
        body: vec![],
    }
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires real WASIp3 component; just worker-async-test"]
async fn node_consumes_standard_p3_body_after_handler_return() {
    let component = std::env::var("WASMPLANE_STANDARD_COMPONENT").unwrap();
    let runtime = Wasip3Runtime::new().unwrap();
    let response = runtime
        .invoke_component_handle_with_limits_and_policy_async(
            Path::new(&component),
            request(),
            InvocationLimits::default(),
            HostPolicy::deny_all(),
        )
        .await
        .unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(response.body, b"first\nsecond\n");
    assert_eq!(runtime.prepared_component_count(), 1);
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires real WASIp3 component; just worker-async-test"]
async fn node_deadline_includes_stream_production() {
    let component = std::env::var("WASMPLANE_STANDARD_COMPONENT").unwrap();
    let runtime = Wasip3Runtime::new().unwrap();
    let error = runtime
        .invoke_component_handle_with_limits_and_policy_async(
            Path::new(&component),
            request(),
            InvocationLimits {
                wall_ms: Some(100),
                ..Default::default()
            },
            HostPolicy::deny_all(),
        )
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("wallMs limit exceeded"),
        "{error:#}"
    );
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires real WASIp3 component; just worker-async-test"]
async fn node_precompiled_cache_and_body_limits() {
    use wasmplane_runtime_core::node::precompile_component_with_pooling;
    let component = std::env::var("WASMPLANE_WORKER_COMPONENT").unwrap();
    let dir = tempfile::tempdir().unwrap();
    let artifact = dir.path().join("worker.cwasm");
    precompile_component_with_pooling(Path::new(&component), &artifact, None).unwrap();
    let runtime = Wasip3Runtime::new().unwrap();
    for _ in 0..2 {
        let response = runtime
            .invoke_precompiled_component_handle_with_limits_and_policy_async(
                &artifact,
                request(),
                InvocationLimits::default(),
                HostPolicy::deny_all(),
            )
            .await
            .unwrap();
        assert_eq!(response.body, b"hello from wasmplane: GET http://worker/");
    }
    assert_eq!(runtime.prepared_component_count(), 1);
    let error = runtime
        .invoke_precompiled_component_handle_with_limits_and_policy_async(
            &artifact,
            request(),
            InvocationLimits {
                response_bytes: Some(3),
                ..Default::default()
            },
            HostPolicy::deny_all(),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("responseBytes"), "{error:#}");
    let mut input = request();
    input.body = vec![1; 4];
    let error = runtime
        .invoke_precompiled_component_handle_with_limits_and_policy_async(
            &artifact,
            input,
            InvocationLimits {
                request_bytes: Some(3),
                ..Default::default()
            },
            HostPolicy::deny_all(),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("requestBytes"), "{error:#}");
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires real WASIp3 component; just worker-async-test"]
async fn node_caller_cancels_cpu_guest_and_next_store_is_healthy() {
    let component = std::env::var("WASMPLANE_WORKER_COMPONENT").unwrap();
    let path = Path::new(&component);
    let runtime = Wasip3Runtime::new().unwrap();
    runtime
        .invoke_component_handle_with_limits_and_policy_async(
            path,
            request(),
            InvocationLimits::default(),
            HostPolicy::deny_all(),
        )
        .await
        .unwrap();
    let mut input = request();
    input.uri = "http://worker/spin".into();
    let result = tokio::time::timeout(
        std::time::Duration::from_millis(50),
        runtime.invoke_component_handle_with_limits_and_policy_async(
            path,
            input,
            InvocationLimits {
                wall_ms: Some(5000),
                ..Default::default()
            },
            HostPolicy::deny_all(),
        ),
    )
    .await;
    assert!(
        result.is_err(),
        "caller cancellation must win before the invocation deadline"
    );
    let response = runtime
        .invoke_component_handle_with_limits_and_policy_async(
            path,
            request(),
            InvocationLimits::default(),
            HostPolicy::deny_all(),
        )
        .await
        .unwrap();
    assert_eq!(response.status, 200);
}

#[test]
fn node_compiler_rejects_a_component_without_standard_http_exports() {
    use wasmplane_runtime_core::node::precompile_component_with_pooling;
    let dir = tempfile::tempdir().unwrap();
    let component = dir.path().join("empty.wat");
    let output = dir.path().join("empty.cwasm");
    std::fs::write(&component, "(component)").unwrap();
    assert!(precompile_component_with_pooling(&component, &output, None).is_err());
    assert!(!output.exists());
}
