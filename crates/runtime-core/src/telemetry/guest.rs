//! Language-neutral recording capability. No network or collector credentials in WIT.
use super::{Span, TraceContext};
use crate::runtime::Host;
use wasmtime::component::{Linker, Resource};
mod bindings {
    wasmtime::component::bindgen!({ path: "../../sdk/rust/wit/telemetry.wit", world: "client", imports: { default: trappable }, with: { "oden:telemetry/tracing.span": crate::telemetry::Span } });
}
use bindings::oden::telemetry::tracing::{self, Attribute, Context, Level, Outcome, Value};
pub(crate) fn add_to_linker(linker: &mut Linker<Host>) -> wasmtime::Result<()> {
    bindings::Client::add_to_linker::<Host, Host>(linker, |host| host)
}
fn context(value: Context) -> Option<TraceContext> {
    TraceContext::parse(&value.traceparent, &value.tracestate)
}
fn attribute(value: Attribute) -> (String, serde_json::Value) {
    (
        value.key,
        match value.value {
            Value::Text(v) => v.into(),
            Value::Signed(v) => v.into(),
            Value::Real(v) => serde_json::json!(v),
            Value::Boolean(v) => v.into(),
        },
    )
}
impl tracing::Host for Host {
    fn start_span(
        &mut self,
        parent: Option<Context>,
        name: String,
    ) -> wasmtime::Result<Option<Resource<Span>>> {
        if !self.telemetry.enabled() {
            return Ok(None);
        }
        if self.telemetry_spans >= 256 {
            self.telemetry.dropped();
            return Ok(None);
        }
        let parent = parent.and_then(context);
        let span = self.telemetry.span(&name, parent.as_ref());
        let resource = self.table.push(span)?;
        self.telemetry_spans += 1;
        Ok(Some(resource))
    }
    fn log(
        &mut self,
        parent: Option<Context>,
        level: Level,
        message: String,
        attrs: Vec<Attribute>,
    ) -> wasmtime::Result<()> {
        let parent = parent.and_then(context);
        let level = match level {
            Level::Trace => "trace",
            Level::Debug => "debug",
            Level::Info => "info",
            Level::Warn => "warn",
            Level::Error => "error",
        };
        self.telemetry.log(
            parent.as_ref(),
            level,
            &message,
            attrs.into_iter().take(32).map(attribute).collect(),
        );
        Ok(())
    }
}
impl tracing::HostSpan for Host {
    fn context(&mut self, span: Resource<Span>) -> wasmtime::Result<Context> {
        let ctx = self.table.get(&span)?.context();
        Ok(Context {
            traceparent: ctx.traceparent(),
            tracestate: ctx.tracestate,
        })
    }
    fn event(&mut self, span: Resource<Span>, name: String) -> wasmtime::Result<()> {
        self.table.get(&span)?.event(&name);
        Ok(())
    }
    fn set_attribute(&mut self, span: Resource<Span>, value: Attribute) -> wasmtime::Result<()> {
        let (key, value) = attribute(value);
        self.table.get(&span)?.attribute(&key, value);
        Ok(())
    }
    fn link(&mut self, span: Resource<Span>, value: Context) -> wasmtime::Result<()> {
        if let Some(ctx) = context(value) {
            self.table.get(&span)?.link(&ctx);
        }
        Ok(())
    }
    fn end(&mut self, span: Resource<Span>, outcome: Outcome) -> wasmtime::Result<()> {
        self.table.get(&span)?.finish(match outcome {
            Outcome::Ok => "ok",
            Outcome::Error => "error",
            Outcome::Cancelled => "cancelled",
        });
        Ok(())
    }
    fn drop(&mut self, span: Resource<Span>) -> wasmtime::Result<()> {
        self.table.delete(span)?;
        self.telemetry_spans -= 1;
        Ok(())
    }
}
