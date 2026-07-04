#[allow(warnings)]
mod bindings;

use bindings::Guest;
use bindings::myedge::runtime::bridge;
use bindings::myedge::runtime::http::{new_outgoing_body, OutgoingBody, Request, Response};
use bindings::myedge::runtime::types::{Header, ResponseHead};

struct Component;

impl Guest for Component {
    async fn handle(req: Request) -> Response {
        let moonbit = bridge::ping(35);
        let payload = format!(
            "rust-moonbit sample: {} {} moonbit={moonbit}",
            req.head.method, req.head.uri,
        );
        text_response(200, payload).await
    }
}

async fn text_response(status: u16, body_text: String) -> Response {
    let body = new_outgoing_body();
    OutgoingBody::write(&body, body_text.into_bytes()).await;
    OutgoingBody::finish(&body).await;
    Response {
        head: ResponseHead {
            status,
            headers: vec![Header {
                name: "content-type".to_string(),
                value: "text/plain; charset=utf-8".to_string(),
            }],
        },
        body,
    }
}

bindings::export!(Component with_types_in bindings);
