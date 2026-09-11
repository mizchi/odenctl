/// A lazy producer lets the host read the body after handle returns.
pub fn json(body : String) -> @types.Response {
  let bytes = @utf8.encode(body)
  let headers = @types.Fields::fields()
  ignore(headers.append("content-type", @utf8.encode("application/json").to_fixedarray()))
  let stream = @async-core.Stream::produce(async fn(sink) {
    ignore(sink.write_all_bytes(bytes[:]))
    sink.close()
  })
  let (response, completion) = @types.Response::new(
    headers, Some(stream), @async-core.Future::ready(Ok(None)),
  )
  completion.drop_sync()
  response
}

pub async fn sleep_ms(milliseconds : UInt64) -> Unit {
  @clock.wait_for(milliseconds * 1000000UL)
}

pub async fn log(line : String) -> Unit {
  let bytes = @utf8.encode(line + "\n")
  let stream = @async-core.Stream::produce(async fn(sink) {
    ignore(sink.write_all_bytes(bytes[:]))
    sink.close()
  })
  ignore(@stdout.write_via_stream(stream).get())
}
