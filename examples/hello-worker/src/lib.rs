#[allow(warnings)]
mod bindings;

use bindings::myedge::runtime::http::{new_outgoing_body, OutgoingBody, Request, Response};
use bindings::myedge::runtime::types::{Header, ResponseHead};
use bindings::Guest;

struct Component;

impl Guest for Component {
    async fn handle(req: Request) -> Response {
        let body = new_outgoing_body().await;
        let payload = format!("hello from wasmplane: {} {}", req.head.method, req.head.uri);
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

bindings::export!(Component with_types_in bindings);
