use wasip3::http::types::{ErrorCode, Fields, Request, Response};
use wasip3::{wit_bindgen, wit_future, wit_stream};

struct App;
wasip3::http::service::export!(App);

impl wasip3::exports::http::handler::Guest for App {
    async fn handle(_request: Request) -> Result<Response, ErrorCode> {
        let headers = Fields::new();
        headers
            .set("content-type", &[b"application/octet-stream".to_vec()])
            .unwrap();
        headers
            .set("cache-control", &[b"public, max-age=30".to_vec()])
            .unwrap();
        let (mut writer, reader) = wit_stream::new();
        let (trailers, trailers_rx) = wit_future::new(|| Ok(None));
        let (response, _sent) = Response::new(headers, Some(reader), trailers_rx);
        drop(trailers);
        wit_bindgen::spawn_local(async move {
            let _ = writer.write_all((0..=255).collect()).await;
        });
        Ok(response)
    }
}
