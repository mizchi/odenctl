///|
// Application logic has no dependency on test discovery or Wasm bindings.
fn total_cents(quantity : Int) -> Result[Int, String] {
  if quantity < 1 || quantity > 1000 {
    return Err("quantity must be between 1 and 1000")
  }
  Ok(199 * quantity)
}
