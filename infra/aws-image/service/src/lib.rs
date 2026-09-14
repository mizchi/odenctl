//! Stateless deployment sample with no diagnostic or fault-injection routes.
use oden_service_sdk::{HttpHandler, Lifecycle, types, wasip3};

struct App;
oden_service_sdk::export!(App);

impl Lifecycle for App {
    async fn start() -> Result<(), String> {
        Ok(())
    }
    async fn stop() -> Result<(), String> {
        Ok(())
    }
}

impl HttpHandler for App {
    async fn handle(request: types::Request) -> Result<types::Response, types::ErrorCode> {
        let method = request.get_method();
        let head = matches!(method, types::Method::Head);
        if !head && !matches!(method, types::Method::Get) {
            // Headers become immutable when passed to Response::new.
            let headers = types::Fields::new();
            headers.append("allow", b"GET, HEAD").expect("valid header");
            let (trailers, future) = wasip3::wit_future::new(|| Ok(None));
            let (response, _) = types::Response::new(headers, None, future);
            drop(trailers);
            response.set_status_code(405).expect("valid HTTP status");
            return Ok(response);
        }
        let path = request.get_path_with_query().unwrap_or_default();
        let (status, body) = match path.split('?').next().unwrap_or_default() {
            "/healthz" => (200, r#"{"status":"ok"}"#),
            "/" => (200, r#"{"service":"oden","status":"ok"}"#),
            _ => (404, r#"{"error":"not found"}"#),
        };
        let response = oden_service_sdk::json(if head { String::new() } else { body.into() });
        response.set_status_code(status).expect("valid HTTP status");
        Ok(response)
    }
}
