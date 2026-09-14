///|
let count : Ref[Int] = { val: 0, }

///|
pub async fn start(
  _group : @async-core.TaskGroup[Unit],
) -> Result[Unit, String] {
  Ok(())
}

///|
pub async fn stop(_group : @async-core.TaskGroup[Unit]) -> Result[Unit, String] {
  Ok(())
}

///|
pub async fn handle(
  request : @types.Request,
  _group : @async-core.TaskGroup[Unit],
) -> Result[@types.Response, @types.ErrorCode] {
  request.drop()
  count.val += 1
  Ok(@service.json("{\"count\":\{count.val}}"))
}
