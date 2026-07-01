wit_bindgen::generate!({
    path: "wit",
    world: "worker",
});

use myedge::runtime::http::{OutgoingBody, new_outgoing_body};
use myedge::runtime::types::{Header, ResponseHead};

struct Component;

static mut COUNTER: u32 = 0;

impl Guest for Component {
    async fn handle(_req: Request) -> Response {
        let count = unsafe {
            COUNTER += 1;
            COUNTER
        };
        let body = new_outgoing_body();
        OutgoingBody::write(&body, format!("count={count}").into_bytes()).await;
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

    fn wasmplane_reset() {
        unsafe {
            COUNTER = 0;
        }
    }
}

export!(Component);
