#[allow(warnings)]
mod bindings;

use bindings::Guest;
use bindings::oden::sample::bridge;

struct Component;

impl Guest for Component {
    fn answer() -> u32 {
        bridge::ping(35)
    }
}

bindings::export!(Component with_types_in bindings);
