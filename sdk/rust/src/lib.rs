//! Resident service SDK. The WIT contract is shared with the MoonBit SDK.
pub use wasip3;
pub use wasip3::http::types;
pub mod bindings {
    wasip3::wit_bindgen::generate!({
        path: "wit/lifecycle.wit", world: "lifecycle-hooks",
        generate_all, pub_export_macro: true,
        default_bindings_module: "::oden_service_sdk::bindings",
    });
}
pub use bindings::exports::oden::app::lifecycle::Guest as Lifecycle;
pub use wasip3::exports::http::handler::Guest as HttpHandler;
#[macro_export]
macro_rules! export {
    ($app:ident) => {
        $crate::bindings::export!($app);
        $crate::wasip3::http::service::export!($app);
    };
}

/// Return a JSON body whose writer stays alive after the handler returns.
pub fn json(body: String) -> types::Response {
    let (mut writer, reader) = wasip3::wit_stream::new();
    let (trailers_tx, trailers_rx) = wasip3::wit_future::new(|| Ok(None));
    let headers = types::Fields::new();
    headers.append("content-type", b"application/json").unwrap();
    let (response, _) = types::Response::new(headers, Some(reader), trailers_rx);
    drop(trailers_tx);
    wasip3::wit_bindgen::spawn_local(async move {
        let _ = writer.write_all(body.into_bytes()).await;
    });
    response
}

pub async fn sleep_ms(milliseconds: u64) {
    wasip3::clocks::monotonic_clock::wait_for(milliseconds.saturating_mul(1_000_000)).await;
}

pub mod durable;
pub mod io;
pub mod telemetry;
