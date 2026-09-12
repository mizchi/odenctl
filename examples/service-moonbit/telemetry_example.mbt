///|
async fn telemetry_example(request : @types.Request, group : @async-core.TaskGroup[Unit]) -> String {
  let parent = @service.trace_context(request)
  defer request.drop()
  let span = @service.trace_start(parent, "example.work")
  let context = match span { Some(span) => Some(span.context()); None => parent }
  @service.trace_log(context, "example.foreground")
  group.spawn_bg(async fn() {
    @service.sleep_ms(40UL)
    @service.trace_log(context, "example.background")
    if @service.trace_background(context, "example.detached") is Some(span) { span.end(OK); span.drop() }
  })
  if context is Some(context) {
    if @service.env("TELEMETRY_UPSTREAM") is Some(authority) {
      ignore(@service.fetch_traced(context, { method_: Get, scheme: Http, authority, path: "/echo", headers: [], body: b"", }, 1024))
    }
    if @service.env("TELEMETRY_DURABLE") is Some(_) {
      ignore(@service.durable_fetch_traced(context, "counter", "telemetry", { method_: "GET", path: "/", headers: [], body: [], request_id: None, }))
    }
  }
  if span is Some(span) { span.end(OK); span.drop() }
  "{\"ok\":true}"
}
