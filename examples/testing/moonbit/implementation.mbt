let count : Ref[Int] = { val: 0 }

///|
pub fn arithmetic_test() -> Result[Unit, String] {
  match total_cents(3) {
    Ok(597) => Ok(())
    _ => Err("three items should cost 597 cents")
  }
}

///|
pub fn validation_test() -> Result[Unit, String] {
  if total_cents(0) is Ok(_) || total_cents(1001) is Ok(_) {
    return Err("out-of-range quantity was accepted")
  }
  Ok(())
}

///|
pub fn state_first_test() -> Unit {
  if count.val != 0 { abort("test state was reused") }
  count.val = 1
}

///|
pub fn state_second_test() -> Unit {
  state_first_test()
}

///|
pub async fn timer_test(
  _group : @async-core.TaskGroup[Unit],
) -> Result[Unit, Unit] {
  let before = @clock.now()
  @clock.wait_for(5000000UL)
  if @clock.now() < before + 5000000UL { Err(()) } else { Ok(()) }
}

///|
pub async fn background_test(
  group : @async-core.TaskGroup[Unit],
) -> Result[Unit, String] {
  let worker = group.spawn(async fn() {
    @io.log("Checking background work")
    @clock.wait_for(5000000UL)
    count.val = 1
  })
  // Await completion; tasks still running when a test ends are discarded.
  worker.wait()
  if count.val == 1 { Ok(()) } else { Err("background task did not finish") }
}

///|
pub async fn http_test(
  _group : @async-core.TaskGroup[Unit],
) -> Result[Unit, String] {
  let authority = match @io.env("UPSTREAM_AUTHORITY") {
    Some(value) => value
    None => return Err("set UPSTREAM_AUTHORITY in runtime.json")
  }
  let expected = match @io.env("EXAMPLE_GREETING") {
    Some(value) => value
    None => return Err("set EXAMPLE_GREETING in runtime.json")
  }
  let response = match @io.fetch({
    method_: Get, scheme: Http, authority, path: "/greeting",
    headers: [], body: b"",
  }, 1024) {
    Ok(value) => value
    Err(_) => return Err("outbound HTTP failed")
  }
  if response.status != 200U || response.body != @utf8.encode(expected) {
    return Err("unexpected greeting response")
  }
  Ok(())
}
