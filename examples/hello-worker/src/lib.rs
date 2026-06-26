#[allow(warnings)]
mod bindings;

use bindings::Guest;
use bindings::myedge::runtime::http::{OutgoingBody, Request, Response, new_outgoing_body};
use bindings::myedge::runtime::types::{Header, ResponseHead};
use bindings::myedge::runtime::{kv, outbound, secrets};

struct Component;

impl Guest for Component {
    async fn handle(req: Request) -> Response {
        let body = new_outgoing_body().await;
        let payload = if req.head.uri.ends_with("/capabilities") {
            capability_payload(&req).await
        } else {
            format!("hello from wasmplane: {} {}", req.head.method, req.head.uri)
        };
        OutgoingBody::write(&body, payload.into_bytes()).await;
        OutgoingBody::finish(&body).await;

        Response {
            head: ResponseHead {
                status: 200,
                headers: vec![Header {
                    name: "content-type".to_string(),
                    value: "text/plain".to_string(),
                }],
            },
            body,
        }
    }
}

async fn capability_payload(req: &Request) -> String {
    let kv_value = match kv::open_namespace("MAIN".to_string()).await {
        Some(namespace) => {
            kv::put(&namespace, "probe".to_string(), b"checked".to_vec(), None).await;
            kv::get(&namespace, "probe".to_string())
                .await
                .and_then(|value| String::from_utf8(value).ok())
                .unwrap_or_else(|| "missing".to_string())
        }
        None => "missing".to_string(),
    };
    let secret_len = match secrets::open_secret("API_KEY".to_string()).await {
        Some(secret) => secrets::reveal(&secret).await.len(),
        None => 0,
    };
    let outbound_value = match header(req, "x-upstream-url") {
        Some(uri) => {
            let response = outbound::fetch(outbound::Request {
                method: "GET".to_string(),
                uri,
                headers: Vec::new(),
                body: Vec::new(),
            })
            .await;
            String::from_utf8(response.body).unwrap_or_else(|_| "invalid".to_string())
        }
        None => "missing".to_string(),
    };
    format!("capabilities: kv={kv_value} secret-len={secret_len} outbound={outbound_value}")
}

fn header(req: &Request, name: &str) -> Option<String> {
    req.head
        .headers
        .iter()
        .find(|header| header.name.eq_ignore_ascii_case(name))
        .map(|header| header.value.clone())
}

bindings::export!(Component with_types_in bindings);
