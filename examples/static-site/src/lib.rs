mod site;

#[cfg(target_arch = "wasm32")]
mod guest {
    use wasip3::http::types::{ErrorCode, Fields, Method, Request, Response};
    use wasip3::{wit_bindgen, wit_future, wit_stream};

    struct App;
    wasip3::http::service::export!(App);

    impl wasip3::exports::http::handler::Guest for App {
        async fn handle(request: Request) -> Result<Response, ErrorCode> {
            let method = match request.get_method() {
                Method::Get => "GET",
                Method::Head => "HEAD",
                _ => "OTHER",
            };
            let path = request.get_path_with_query().unwrap_or_else(|| "/".into());
            let page = super::site::respond(method, &path);
            let headers = Fields::new();
            for (name, value) in page.headers {
                headers.set(name, &[value.into_bytes()]).unwrap();
            }
            let (mut writer, reader) = wit_stream::new();
            let (trailers, trailers_rx) = wit_future::new(|| Ok(None));
            let (response, _sent) = Response::new(headers, Some(reader), trailers_rx);
            response.set_status_code(page.status).unwrap();
            drop(trailers);
            wit_bindgen::spawn_local(async move {
                let _ = writer.write_all(page.body).await;
            });
            Ok(response)
        }
    }
}
