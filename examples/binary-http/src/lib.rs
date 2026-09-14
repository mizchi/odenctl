use wasip3::http::types::{ErrorCode, Fields, Request, Response};
use wasip3::wit_bindgen::rt::async_support::StreamResult;
use wasip3::{wit_bindgen, wit_future, wit_stream};

struct App;
wasip3::http::service::export!(App);

impl wasip3::exports::http::handler::Guest for App {
    async fn handle(request: Request) -> Result<Response, ErrorCode> {
        let (done_tx, done_rx) = wit_future::new(|| Ok(()));
        let (mut input, trailers) = Request::consume_body(request, done_rx);
        let (mut writer, reader) = wit_stream::new();
        let headers = Fields::new();
        headers
            .set("content-type", &[b"application/octet-stream".to_vec()])
            .unwrap();
        let (response, _sent) = Response::new(headers, Some(reader), trailers);
        wit_bindgen::spawn_local(async move {
            loop {
                let (status, bytes) = input.read(Vec::with_capacity(16 * 1024)).await;
                if !writer.write_all(bytes).await.is_empty() {
                    break;
                }
                if matches!(status, StreamResult::Dropped) {
                    break;
                }
            }
            drop(done_tx);
        });
        Ok(response)
    }
}
