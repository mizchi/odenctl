;; Directly runnable component text. Contract: ../../wit/durable/objects.wit.
;; Increment counter/wat-counter once, using a fixed request ID for safe retries.
(component
  (type $objects (instance
    (export "object" (type (sub resource))) ;; 0
    (type (variant (case "binding-denied") (case "invalid-request" string)
      (case "unavailable") (case "deadline-exceeded") (case "outcome-unknown")))
    (export "error" (type (eq 1))) ;; 2
    (type (tuple string string)) ;; 3
    (type (list 3)) ;; 4: headers
    (type (list u8)) ;; 5: body
    (type (option string)) ;; 6: request-id
    (type (record (field "method" string) (field "path" string)
      (field "headers" 4) (field "body" 5) (field "request-id" 6)))
    (export "request" (type (eq 7))) ;; 8
    (type (record (field "status" u16) (field "headers" 4) (field "body" 5)))
    (export "response" (type (eq 9))) ;; 10
    (type (borrow 0)) ;; 11
    (type (result 10 (error 2))) ;; 12
    (type (func async (param "self" 11) (param "req" 8) (result 12)))
    (export "[method]object.fetch" (func (type 13)))
    (type (own 0)) ;; 14
    (type (result 14 (error 2))) ;; 15
    (type (func (param "binding" string) (param "name" string) (result 15)))
    (export "open" (func (type 16)))
  ))
  (import "oden:durable/objects@0.1.0" (instance $objects (type $objects)))

  ;; A separate memory instance breaks the cycle between canonical lowering
  ;; (which needs memory/realloc) and the application (which calls the imports).
  (core module $heap
    (memory (export "memory") 1 1)
    (global $next (mut i32) (i32.const 1024))
    ;; Bump allocator for this one-shot example; trap if its 64 KiB is exhausted.
    (func (export "realloc") (param $old i32) (param $old-size i32)
        (param $align i32) (param $size i32) (result i32)
      (local $ptr i32)
      (if (i32.eqz (local.get $size)) (then (return (i32.const 0))))
      (local.set $ptr (i32.and
        (i32.add (global.get $next) (i32.sub (local.get $align) (i32.const 1)))
        (i32.sub (i32.const 0) (local.get $align))))
      (if (i32.gt_u (local.get $size) (i32.sub (i32.const 65536) (local.get $ptr)))
        (then unreachable))
      (global.set $next (i32.add (local.get $ptr) (local.get $size)))
      (memory.copy (local.get $ptr) (local.get $old)
        (select (local.get $old-size) (local.get $size)
          (i32.lt_u (local.get $old-size) (local.get $size))))
      (local.get $ptr)
    )
  )
  (core instance $heap (instantiate $heap))
  (alias core export $heap "memory" (core memory $memory))
  (alias core export $heap "realloc" (core func $realloc))
  (alias export $objects "object" (type $object))
  (alias export $objects "open" (func $open))
  (alias export $objects "[method]object.fetch" (func $fetch))
  (core func $lower-open (canon lower (func $open) (memory $memory) (realloc $realloc)))
  ;; Synchronous lowering lets this command wait for the async host function
  ;; without implementing the guest-side callback / waitable ABI by hand.
  (core func $lower-fetch (canon lower (func $fetch) (memory $memory) (realloc $realloc)))
  (core func $drop (canon resource.drop $object))
  (core func $task-return (canon task.return (result (result))))
  (core instance $host
    (export "memory" (memory $memory))
    (export "open" (func $lower-open))
    (export "fetch" (func $lower-fetch))
    (export "drop" (func $drop))
    (export "task-return" (func $task-return))
  )
  (core module $app
    (import "host" "memory" (memory 1 1))
    (import "host" "open" (func $open (param i32 i32 i32 i32 i32)))
    (import "host" "fetch" (func $fetch
      (param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32)))
    (import "host" "drop" (func $drop (param i32)))
    (import "host" "task-return" (func $task-return (param i32)))
    (data (i32.const 0) "counter")
    (data (i32.const 16) "wat-counter")
    (data (i32.const 32) "POST")
    (data (i32.const 48) "/increment")
    (data (i32.const 64) "wat-request-1")
    (func $increment (result i32)
      (local $object i32)
      ;; open("counter", "wat-counter"), writing result<object, error> at 128.
      (call $open (i32.const 0) (i32.const 7) (i32.const 16) (i32.const 11) (i32.const 128))
      (if (i32.load8_u (i32.const 128)) (then (return (i32.const 1))))
      (local.set $object (i32.load (i32.const 132)))
      ;; fetch(POST /increment, [], [], some("wat-request-1")), result at 160.
      (call $fetch (local.get $object)
        (i32.const 32) (i32.const 4) (i32.const 48) (i32.const 10)
        (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)
        (i32.const 1) (i32.const 64) (i32.const 13) (i32.const 160))
      (call $drop (local.get $object))
      (if (i32.load8_u (i32.const 160)) (then (return (i32.const 1))))
      ;; result::ok iff the actor returned HTTP 200. No stdout imports needed.
      (i32.ne (i32.load16_u (i32.const 164)) (i32.const 200))
    )
    (func (export "run") (call $task-return (call $increment)))
  )
  (core instance $app (instantiate $app (with "host" (instance $host))))
  (func $run async (result (result)) (canon lift (core func $app "run") async))
  (instance $cli (export "run" (func $run)))
  (export "wasi:cli/run@0.3.0" (instance $cli))
)
