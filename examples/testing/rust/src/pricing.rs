// Application logic has no dependency on test discovery or Wasm bindings.
pub fn total_cents(quantity: u32) -> Result<u32, String> {
    if !(1..=1000).contains(&quantity) {
        return Err("quantity must be between 1 and 1000".into());
    }
    Ok(199 * quantity)
}
