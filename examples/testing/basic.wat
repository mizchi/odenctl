(component
  (core module $logic
    (global $count (mut i32) (i32.const 0))
    (func (export "arithmetic")
      i32.const 199 i32.const 3 i32.mul
      i32.const 597 i32.ne
      if unreachable end)
    (func (export "state")
      global.get $count
      if unreachable end
      i32.const 1 global.set $count))
  (core instance $logic (instantiate $logic))
  (func $arithmetic (canon lift (core func $logic "arithmetic")))
  (func $state (canon lift (core func $logic "state")))
  (export "arithmetic-test" (func $arithmetic))
  ;; Both pass because each test receives a new instance.
  (export "state-first-test" (func $state))
  (export "state-second-test" (func $state)))
