//! Explicit trace contexts: move/clone them into async tasks, never install a global span.
mod bindings {
    wasip3::wit_bindgen::generate!({ path: "wit/telemetry.wit", world: "client", generate_all });
}
pub use bindings::wasmplane::telemetry::tracing::{
    Attribute, Context, Level, Outcome, Span, Value, log, start_span,
};

/// The host places its server span context in the guest request headers.
pub fn from_request(request: &crate::types::Request) -> Option<Context> {
    let headers = request.get_headers();
    let parent = headers.get("traceparent");
    if parent.len() != 1 {
        return None;
    }
    Some(Context {
        traceparent: String::from_utf8(parent[0].clone()).ok()?,
        tracestate: headers
            .get("tracestate")
            .iter()
            .filter_map(|v| std::str::from_utf8(v).ok())
            .collect::<Vec<_>>()
            .join(","),
    })
}
pub fn inject(context: &Context, headers: &mut Vec<(String, Vec<u8>)>) {
    headers.retain(|(name, _)| {
        !name.eq_ignore_ascii_case("traceparent") && !name.eq_ignore_ascii_case("tracestate")
    });
    headers.push((
        "traceparent".into(),
        context.traceparent.as_bytes().to_vec(),
    ));
    if !context.tracestate.is_empty() {
        headers.push(("tracestate".into(), context.tracestate.as_bytes().to_vec()));
    }
}
/// Only the value is inherited. A background task may outlive the originating span.
pub fn spawn<F, Work>(context: Option<Context>, work: F)
where
    F: FnOnce(Option<Context>) -> Work + 'static,
    Work: std::future::Future<Output = ()> + 'static,
{
    wasip3::wit_bindgen::spawn_local(async move { work(context).await });
}
/// A linked root span for work independent of the originating HTTP lifetime.
pub fn background(name: &str, origin: Option<&Context>) -> Option<Span> {
    let span = start_span(None, name)?;
    if let Some(context) = origin {
        span.link(context);
    }
    Some(span)
}
