use wasmplane_service_sdk::{durable, io, sleep_ms, telemetry as t, types};
pub async fn handle(request: &types::Request) -> String {
    let parent = t::from_request(request);
    let span = t::start_span(parent.as_ref(), "example.work");
    let context = span.as_ref().map(|s| s.context()).or(parent);
    t::log(context.as_ref(), t::Level::Info, "example.foreground", &[]);
    let captured = context.clone();
    wasmplane_service_sdk::wasip3::wit_bindgen::spawn_local(async move {
        sleep_ms(40).await;
        t::log(captured.as_ref(), t::Level::Info, "example.background", &[]);
        if let Some(span) = t::background("example.detached", captured.as_ref()) {
            span.end(t::Outcome::Ok);
        }
    });
    if let Some(context) = &context {
        if let Some(authority) = io::env("TELEMETRY_UPSTREAM") {
            io::fetch_traced(
                context,
                io::HttpRequest {
                    method: types::Method::Get,
                    scheme: types::Scheme::Http,
                    authority,
                    path: "/echo".into(),
                    headers: vec![],
                    body: vec![],
                },
                1024,
            )
            .await
            .unwrap();
        }
        if io::env("TELEMETRY_DURABLE").is_some() {
            durable::fetch_traced(
                context,
                "counter",
                "telemetry",
                durable::Request {
                    method: "GET".into(),
                    path: "/".into(),
                    headers: vec![],
                    body: vec![],
                    request_id: None,
                },
            )
            .await
            .unwrap();
        }
    }
    if let Some(span) = span {
        span.end(t::Outcome::Ok);
    }
    "{\"ok\":true}".into()
}
