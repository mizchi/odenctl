///| Explicit values travel with the async task; there is no Store-global context.
pub fn trace_context(request : @types.Request) -> @tracing.Context? {
  let headers = request.get_headers()
  defer headers.drop()
  let parents = headers.get("traceparent")
  if parents.length() != 1 { return None }
  let states = headers.get("tracestate")
  try {
    Some({ traceparent: @utf8.decode(Bytes::from_array(parents[0][:])), tracestate: states.map(fn(value) raise { @utf8.decode(Bytes::from_array(value[:])) }).join(",") })
  } catch { _ => None }
}

///|
pub fn trace_start(context : @tracing.Context?, name : String) -> @tracing.Span? {
  @tracing.start_span(context, name)
}

///|
pub fn trace_log(context : @tracing.Context?, message : String) -> Unit {
  @tracing.log(context, INFO, message, [])
}

///|
pub fn trace_background(origin : @tracing.Context?, name : String) -> @tracing.Span? {
  let span = @tracing.start_span(None, name)
  if span is Some(span) { if origin is Some(context) { span.link(context) } }
  span
}

///|
pub async fn fetch_traced(context : @tracing.Context, input : HttpRequest, limit : Int) -> Result[HttpResponse, IoError] {
  let headers = input.headers.filter(fn(pair) { let name = pair.0.to_lower(); name != "traceparent" && name != "tracestate" })
  headers.push(("traceparent", @utf8.encode(context.traceparent).to_fixedarray()))
  if context.tracestate != "" { headers.push(("tracestate", @utf8.encode(context.tracestate).to_fixedarray())) }
  fetch({ ..input, headers, }, limit)
}

///|
pub async fn durable_fetch_traced(context : @tracing.Context, binding : String, name : String, request : @objects.Request) -> Result[@objects.Response, @objects.Error_] {
  let headers = request.headers.filter(fn(pair) { let name = pair.0.to_lower(); name != "traceparent" && name != "tracestate" })
  headers.push(("traceparent", context.traceparent))
  if context.tracestate != "" { headers.push(("tracestate", context.tracestate)) }
  durable_fetch(binding, name, { ..request, headers, })
}
