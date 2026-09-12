///|
pub async fn start(_background_group : @async-core.TaskGroup[Unit]) -> Result[Unit, String] {
  Ok(())
}

///|
pub async fn stop(_background_group : @async-core.TaskGroup[Unit]) -> Result[Unit, String] {
  Ok(())
}

///| Assert that Canonical ABI conversions preserve every nested value.
fn validate(input : @operations.Payload) -> Unit {
  if input.label != "roundtrip 日本語 🦀" { abort("label changed") }
  match input.modes {
    [STEADY, BURST] => ()
    _ => abort("modes changed")
  }
  match input.detail {
    Some(Numbers(values)) => {
      if values.length() != 3 || values[0] != 1U || values[1] != 2U || values[2] != 3U {
        abort("numbers changed")
      }
    }
    _ => abort("detail changed")
  }
  if input.pair.0 != 7U || input.pair.1 != "tuple" { abort("tuple changed") }
}

///|
pub async fn handle(
  request : @types.Request,
  _background_group : @async-core.TaskGroup[Unit],
) -> Result[@types.Response, @types.ErrorCode] {
  defer request.drop()
  let context = @service.trace_context(request).unwrap()
  let value = if request.get_path_with_query() == Some("/error") { 0U } else { 41U }
  let input = @operations.echo({
    label: "roundtrip 日本語 🦀",
    value,
    modes: [STEADY, BURST],
    detail: Some(Numbers([1U, 2U, 3U])),
    pair: (7U, "tuple"),
  })
  validate(input)
  let body = match @operations.work(context, input) {
    Ok(output) => {
      validate(output)
      "{\"value\":\{output.value},\"label\":\"\{output.label}\"}"
    }
    Err(message) => {
      if message != "zero is rejected" { abort("error changed") }
      "{\"error\":true,\"message\":\"zero is rejected\"}"
    }
  }
  Ok(@service.json(body))
}
