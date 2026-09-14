use std::cell::Cell;
use oden_service_sdk::{io, sleep_ms, types, wasip3};

mod pricing;
wit_bindgen::generate!({
    path: "../wit", world: "suite", generate_all,
    with: {
        "wasi:clocks/monotonic-clock@0.3.0": wasip3::clocks::monotonic_clock,
        "wasi:clocks/types@0.3.0": wasip3::clocks::types,
        "wasi:cli/environment@0.3.0": wasip3::cli::environment,
        "wasi:http/client@0.3.0": wasip3::http::client,
        "wasi:http/types@0.3.0": wasip3::http::types,
    },
});

struct Tests;
export!(Tests);
thread_local! { static COUNT: Cell<u32> = const { Cell::new(0) }; }

impl exports::example::testing::checks::Guest for Tests {
    fn arithmetic_test() -> Result<(), String> {
        println!("Checking the pricing calculation");
        if pricing::total_cents(3)? != 597 {
            return Err("three items should cost 597 cents".into());
        }
        Ok(())
    }

    fn validation_test() -> Result<(), String> {
        if pricing::total_cents(0).is_ok() || pricing::total_cents(1001).is_ok() {
            return Err("out-of-range quantity was accepted".into());
        }
        Ok(())
    }

    fn state_first_test() {
        COUNT.with(|count| assert_eq!(count.replace(1), 0));
    }

    fn state_second_test() {
        Self::state_first_test();
    }

    async fn timer_test() -> Result<(), ()> {
        let before = wasip3::clocks::monotonic_clock::now();
        sleep_ms(5).await;
        (wasip3::clocks::monotonic_clock::now() >= before + 5_000_000)
            .then_some(())
            .ok_or(())
    }

    async fn background_test() -> Result<(), String> {
        let (sender, receiver) = futures_channel::oneshot::channel();
        wasip3::wit_bindgen::spawn_local(async move {
            sleep_ms(5).await;
            COUNT.with(|count| count.set(1));
            let _ = sender.send(());
        });
        // Await completion; tasks still running when a test ends are discarded.
        receiver
            .await
            .map_err(|_| "background task was cancelled")?;
        if COUNT.with(Cell::get) != 1 {
            return Err("background task did not finish".into());
        }
        Ok(())
    }

    async fn http_test() -> Result<(), String> {
        let authority =
            io::env("UPSTREAM_AUTHORITY").ok_or("set UPSTREAM_AUTHORITY in runtime.json")?;
        let expected = io::env("EXAMPLE_GREETING").ok_or("set EXAMPLE_GREETING in runtime.json")?;
        let response = io::fetch(
            io::HttpRequest {
                method: types::Method::Get,
                scheme: types::Scheme::Http,
                authority,
                path: "/greeting".into(),
                headers: vec![],
                body: vec![],
            },
            1024,
        )
        .await
        .map_err(|error| format!("outbound HTTP failed: {error:?}"))?;
        if response.status != 200 || response.body != expected.as_bytes() {
            return Err("unexpected greeting response".into());
        }
        Ok(())
    }
}
