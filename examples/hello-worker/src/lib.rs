use wasip3::http::types::{ErrorCode, Fields, Method, Request, Response, Scheme};
use wasip3::{wit_bindgen, wit_future, wit_stream};

struct App;
wasip3::http::service::export!(App);

impl wasip3::exports::http::handler::Guest for App {
    async fn handle(request: Request) -> Result<Response, ErrorCode> {
        let path = request.get_path_with_query().unwrap_or_else(|| "/".into());
        if path == "/spin" { loop { std::hint::spin_loop(); } }
        if path == "/trap" { panic!("test guest trap"); }
        if path == "/fetch" {
            let url = request.get_headers().get("x-upstream-url").into_iter().next()
                .and_then(|bytes| String::from_utf8(bytes).ok()).ok_or(ErrorCode::HttpRequestUriInvalid)?;
            let (scheme, rest) = if let Some(rest) = url.strip_prefix("http://") { (Scheme::Http, rest) }
                else if let Some(rest) = url.strip_prefix("https://") { (Scheme::Https, rest) }
                else { return Err(ErrorCode::HttpRequestUriInvalid); };
            let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
            let (tx, trailers) = wit_future::new(|| Ok(None));
            drop(tx);
            let (outbound, _sent) = Request::new(Fields::new(), None, trailers, None);
            outbound.set_scheme(Some(&scheme)).unwrap();
            outbound.set_authority(Some(authority)).unwrap();
            outbound.set_path_with_query(Some(&format!("/{path}"))).unwrap();
            return wasip3::http::client::send(outbound).await;
        }
        let method = match request.get_method() {
            Method::Get => "GET".into(), Method::Post => "POST".into(), Method::Put => "PUT".into(),
            Method::Delete => "DELETE".into(), Method::Head => "HEAD".into(), Method::Patch => "PATCH".into(),
            Method::Options => "OPTIONS".into(), Method::Connect => "CONNECT".into(), Method::Trace => "TRACE".into(),
            Method::Other(method) => method,
        };
        let authority = request.get_authority().unwrap_or_default();
        let scheme = match request.get_scheme() { Some(Scheme::Https) => "https", _ => "http" };
        Ok(text_response(format!("hello from wasmplane: {method} {scheme}://{authority}{path}")))
    }
}

fn text_response(text: String) -> Response {
    let (mut writer, reader) = wit_stream::new();
    let (tx, trailers) = wit_future::new(|| Ok(None));
    drop(tx);
    let fields = Fields::new();
    fields.set("content-type", &[b"text/plain; charset=utf-8".to_vec()]).unwrap();
    let (response, _sent) = Response::new(fields, Some(reader), trailers);
    wit_bindgen::spawn_local(async move { let _ = writer.write_all(text.into_bytes()).await; });
    response
}
