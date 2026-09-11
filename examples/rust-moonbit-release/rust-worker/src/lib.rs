use wasip3::http::types::{ErrorCode, Fields, Request, Response};
use wasip3::{wit_future, wit_stream};
mod bindings {
    wit_bindgen::generate!({ path: "../wit/worker.wit", world: "worker" });
}
struct App;
wasip3::http::service::export!(App);
impl wasip3::exports::http::handler::Guest for App {
    async fn handle(request: Request) -> Result<Response, ErrorCode> {
        let moonbit = bindings::wasmplane::sample::bridge::ping(35);
        Ok(text_response(format!("rust-moonbit sample: {} moonbit={moonbit}", request.get_path_with_query().unwrap_or_default())))
    }
}

fn text_response(text: String) -> Response {
    let (mut writer, reader) = wit_stream::new();
    let (tx, trailers) = wit_future::new(|| Ok(None));
    drop(tx);
    let fields = Fields::new();
    fields.set("content-type", &[b"text/plain; charset=utf-8".to_vec()]).unwrap();
    let (response, _sent) = Response::new(fields, Some(reader), trailers);
    wasip3::wit_bindgen::spawn_local(async move { let _ = writer.write_all(text.into_bytes()).await; });
    response
}
