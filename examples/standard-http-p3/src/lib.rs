use wasip3::http::types::{ErrorCode, Fields, Request, Response};
use wasip3::{wit_bindgen, wit_future, wit_stream};

struct App;
wasip3::http::service::export!(App);

impl wasip3::exports::http::handler::Guest for App {
    async fn handle(_request: Request) -> Result<Response, ErrorCode> {
        let (mut writer, reader) = wit_stream::new();
        let (trailers_tx, trailers_rx) = wit_future::new(|| Ok(None));
        let (response, _transmission) = Response::new(Fields::new(), Some(reader), trailers_rx);
        drop(trailers_tx);
        wit_bindgen::spawn_local(async move {
            if !writer.write_all(b"first\n".to_vec()).await.is_empty() {
                return;
            }
            wasip3::clocks::monotonic_clock::wait_for(1_000_000_000).await;
            let _ = writer.write_all(b"second\n".to_vec()).await;
        });
        // The host must continue servicing the stream after this export returns.
        Ok(response)
    }
}
