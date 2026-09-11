use std::collections::BTreeMap;
use wasmplane_runtime_core::durable::{DurableClient, FetchError, FetchRequest, GatewayBinding};

#[tokio::test]
async fn unbound_objects_are_rejected_before_network_access() {
    let client = DurableClient::new(BTreeMap::new(), |_| None, 100, 1024, 1).unwrap();
    assert!(matches!(
        client.open("missing", "one"),
        Err(FetchError::BindingDenied)
    ));
}

#[tokio::test]
async fn timeout_after_dispatch_is_unknown_and_is_not_retried() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let peer = tokio::spawn(async move {
        let (mut connection, _) = listener.accept().await.unwrap();
        let mut bytes = vec![0; 4096];
        let n = connection.read(&mut bytes).await.unwrap();
        let request = String::from_utf8_lossy(&bytes[..n]);
        assert!(request.contains("/v1/objects/COUNTER/one/fetch"));
        assert!(
            request
                .to_lowercase()
                .contains("authorization: bearer test-secret")
        );
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let _ = connection
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
            .await;
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), listener.accept())
                .await
                .is_err()
        );
    });
    let config = BTreeMap::from([(
        "counter".into(),
        GatewayBinding {
            endpoint,
            namespace: "COUNTER".into(),
            token_env: "TOKEN".into(),
        },
    )]);
    let client = DurableClient::new(config, |_| Some("test-secret".into()), 50, 1024, 1).unwrap();
    let object = client.open("counter", "one").unwrap();
    let result = client
        .fetch(
            &object,
            FetchRequest {
                method: "POST".into(),
                path: "/increment".into(),
                headers: vec![],
                body: vec![],
                request_id: Some("id-1".into()),
            },
        )
        .await;
    assert!(
        matches!(result, Err(FetchError::OutcomeUnknown)),
        "{result:?}"
    );
    peer.await.unwrap();
}
