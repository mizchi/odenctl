//! celld bindings preserve adapter errors, including unknown mutation outcomes.
mod bindings {
    wasip3::wit_bindgen::generate!({ path: "wit/durable.wit", world: "client", generate_all });
}
pub use bindings::oden::durable::objects::{Error, Object, Request, Response, open};

/// Opens a scoped object handle, dispatches once and drops the handle.
/// An unknown outcome is returned to the caller; this function never retries.
pub async fn fetch(binding: &str, name: &str, request: Request) -> Result<Response, Error> {
    let object = open(binding, name)?;
    object.fetch(request).await
}

pub async fn fetch_traced(
    context: &crate::telemetry::Context,
    binding: &str,
    name: &str,
    mut request: Request,
) -> Result<Response, Error> {
    request.headers.retain(|(key, _)| {
        !key.eq_ignore_ascii_case("traceparent") && !key.eq_ignore_ascii_case("tracestate")
    });
    request
        .headers
        .push(("traceparent".into(), context.traceparent.clone()));
    if !context.tracestate.is_empty() {
        request
            .headers
            .push(("tracestate".into(), context.tracestate.clone()));
    }
    fetch(binding, name, request).await
}
