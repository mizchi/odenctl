mod io_example;
mod telemetry_example;
use std::cell::Cell;
use wasip3::http::types::{ErrorCode, Request, Response};
use wasip3::wit_bindgen;
use oden_service_sdk::{HttpHandler, Lifecycle, wasip3};

struct App;
oden_service_sdk::export!(App);

thread_local! {
    static STARTS: Cell<u32> = const { Cell::new(0) };
    static COUNT: Cell<u32> = const { Cell::new(0) };
    static TICKS: Cell<u32> = const { Cell::new(0) };
    static STOPPED: Cell<bool> = const { Cell::new(false) };
}

fn log(line: &str) -> Result<(), String> {
    println!("lifecycle:{line}");
    Ok(())
}

impl Lifecycle for App {
    async fn start() -> Result<(), String> {
        match std::env::var("SERVICE_START").as_deref() {
            Ok("error") => return Err("requested startup failure".into()),
            Ok("loop") => loop {
                std::hint::spin_loop();
            },
            _ => {}
        }
        STARTS.set(STARTS.get() + 1);
        log("start")?;
        wit_bindgen::spawn_local(async {
            while !STOPPED.get() {
                wasip3::clocks::monotonic_clock::wait_for(20_000_000).await;
                TICKS.set(TICKS.get() + 1);
            }
        });
        Ok(())
    }
    async fn stop() -> Result<(), String> {
        if std::env::var("SERVICE_STOP").as_deref() == Ok("loop") {
            loop {
                std::hint::spin_loop();
            }
        }
        STOPPED.set(true);
        log("stop")
    }
}

impl HttpHandler for App {
    async fn handle(request: Request) -> Result<Response, ErrorCode> {
        let path = request.get_path_with_query().unwrap_or_default();
        if path == "/telemetry" {
            return Ok(oden_service_sdk::json(
                telemetry_example::handle(&request).await,
            ));
        }
        if let Some(value) = io_example::handle(&path).await {
            return Ok(oden_service_sdk::json(value.to_string()));
        }
        match path.as_str() {
            "/trap" => panic!("service test trap"),
            "/loop" => loop {
                std::hint::spin_loop();
            },
            "/slow" => wasip3::clocks::monotonic_clock::wait_for(200_000_000).await,
            _ => {}
        }
        COUNT.set(COUNT.get() + 1);
        let text = format!(
            "{{\"starts\":{},\"count\":{},\"ticks\":{}}}",
            STARTS.get(),
            COUNT.get(),
            TICKS.get()
        );
        Ok(oden_service_sdk::json(text))
    }
}
