use std::cell::Cell;
use wasmplane_service_sdk::{HttpHandler, Lifecycle, json, types::{ErrorCode, Request, Response}};

struct App;
wasmplane_service_sdk::export!(App);
thread_local! { static COUNT: Cell<u32> = const { Cell::new(0) }; }

impl Lifecycle for App {
    async fn start() -> Result<(), String> { Ok(()) }
    async fn stop() -> Result<(), String> { Ok(()) }
}
impl HttpHandler for App {
    async fn handle(_request: Request) -> Result<Response, ErrorCode> {
        COUNT.set(COUNT.get() + 1);
        Ok(json(format!("{{\"count\":{}}}", COUNT.get())))
    }
}
