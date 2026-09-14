use wasip2::http::types::{
    Fields, IncomingRequest, Method, OutgoingBody, OutgoingRequest, OutgoingResponse,
    ResponseOutparam, Scheme,
};
use wasip2::io::streams::StreamError;

struct App;
wasip2::http::proxy::export!(App);

impl wasip2::exports::http::incoming_handler::Guest for App {
    fn handle(request: IncomingRequest, out: ResponseOutparam) {
        let path = request.path_with_query().unwrap_or_default();
        if path == "/trap" {
            panic!("test guest trap");
        }
        let response = OutgoingResponse::new(Fields::new());
        let body = response.body().unwrap();
        // Outbound failures happen before sending the response headers.
        let text = match path.as_str() {
            "/fetch" => fetch_upstream(),
            "/env" => std::env::var("ODEN_TEST_PRIVATE")
                .unwrap_or_else(|_| "env denied".into())
                .into_bytes(),
            "/file" => std::fs::read("/data/message").unwrap_or_else(|_| b"file denied".to_vec()),
            "/write" => {
                if std::fs::write("/data/message", "changed").is_ok() {
                    b"write allowed".to_vec()
                } else {
                    b"write denied".to_vec()
                }
            }
            _ => b"hello from standalone".to_vec(),
        };
        ResponseOutparam::set(out, Ok(response));
        let stream = body.write().unwrap();
        if path == "/stream" {
            stream.blocking_write_and_flush(b"first\n").unwrap();
            wasip2::clocks::monotonic_clock::subscribe_duration(1_000_000_000).block();
            let _ = stream.blocking_write_and_flush(b"second\n");
        } else {
            stream.blocking_write_and_flush(&text).unwrap();
        }
        drop(stream);
        OutgoingBody::finish(body, None).unwrap();
    }
}

fn fetch_upstream() -> Vec<u8> {
    let origin = std::env::var("UPSTREAM").unwrap();
    let (scheme, authority) = if let Some(rest) = origin.strip_prefix("http://") {
        (Scheme::Http, rest)
    } else {
        (Scheme::Https, origin.strip_prefix("https://").unwrap())
    };
    let request = OutgoingRequest::new(Fields::new());
    request.set_method(&Method::Get).unwrap();
    request.set_scheme(Some(&scheme)).unwrap();
    request.set_authority(Some(authority)).unwrap();
    request.set_path_with_query(Some("/")).unwrap();
    let future = match wasip2::http::outgoing_handler::handle(request, None) {
        Ok(future) => future,
        Err(_) => return b"outbound denied".to_vec(),
    };
    future.subscribe().block();
    let response = match future.get().unwrap().unwrap() {
        Ok(response) => response,
        Err(_) => return b"outbound denied".to_vec(),
    };
    let body = response.consume().unwrap();
    let stream = body.stream().unwrap();
    let mut result = Vec::new();
    loop {
        match stream.blocking_read(8192) {
            Ok(bytes) => result.extend(bytes),
            Err(StreamError::Closed) => break,
            Err(error) => panic!("upstream read: {error:?}"),
        }
    }
    result
}
