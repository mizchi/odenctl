///|
pub async fn work(
  context : @tracing.Context,
  input : Payload,
  _background_group : @async-core.TaskGroup[Unit],
) -> Result[Payload, String] {
  @clock.wait_for(5000000UL)
  @tracing.log(Some(context), INFO, "composed.provider", [])
  if input.value == 0U { return Err("zero is rejected") }
  Ok({ ..input, value: input.value + 1U })
}

///|
pub fn echo(span : Payload) -> Payload {
  span
}
