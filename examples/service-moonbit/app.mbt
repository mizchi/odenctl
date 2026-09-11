let starts : Ref[Int] = { val: 0 }
let count : Ref[Int] = { val: 0 }
let ticks : Ref[Int] = { val: 0 }
let stopped : Ref[Bool] = { val: false }

pub async fn start(background_group : @async-core.TaskGroup[Unit]) -> Result[Unit, String] {
  starts.val += 1
  @service.log("lifecycle:start")
  background_group.spawn_bg(async fn() {
    while !stopped.val {
      @service.sleep_ms(20UL)
      ticks.val += 1
    }
  })
  Ok(())
}

pub async fn stop(_background_group : @async-core.TaskGroup[Unit]) -> Result[Unit, String] {
  stopped.val = true
  @service.log("lifecycle:stop")
  Ok(())
}

pub async fn handle(request : @types.Request, _background_group : @async-core.TaskGroup[Unit]) -> Result[@types.Response, @types.ErrorCode] {
  let path = request.get_path_with_query().unwrap_or("")
  request.drop()
  match path {
    "/trap" => abort("service test trap")
    "/loop" => while true { count.val += 1 }
    "/slow" => @service.sleep_ms(200UL)
    _ => ()
  }
  count.val += 1
  Ok(@service.json("{\"starts\":\{starts.val},\"count\":\{count.val},\"ticks\":\{ticks.val}}"))
}
