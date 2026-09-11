# Standard WASI HTTP contract

The WASI 0.3.0 specifications in `deps/` come from Wasmtime 48.0.2
(`crates/wasi-http/src/p3/wit/deps`, Apache-2.0 WITH LLVM-exception).
The `p2-*` files come from wasip2 1.0.3+wasi-0.2.9 (Apache-2.0 WITH LLVM-exception),
matching the imports emitted by Rust wasm32-wasip2 std.
Both sets are copied without changes. Application HTTP exports use wasi:http/service@0.3.0.

The local `service` validation world permits the standard p2 imports alongside p3 HTTP.
Wasmtime's linker checks the complete component before producing a node cache artifact.
