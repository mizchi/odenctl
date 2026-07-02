#[allow(warnings)]
mod bindings;

use bindings::Guest;

struct Component;

impl Guest for Component {
    fn ping(message: String) -> String {
        message
    }
}

bindings::export!(Component with_types_in bindings);
