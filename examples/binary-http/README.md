# Binary HTTP echo

A minimal WASI P3 component that copies request bytes to the response in 16 KiB
chunks. It returns `application/octet-stream` and preserves NUL, invalid UTF-8,
and image/file bytes. It is a transport example, not an image transformer.

Run from the repository root:

```sh
just binary-http-build
just app-start examples/binary-http/app.json
```

In another terminal, echo a local file and compare the result:

```sh
curl --fail --data-binary @photo.png http://127.0.0.1:8080/echo -o echoed.png
cmp photo.png echoed.png
```

The example manifest limits request and response bodies to 1 MiB and sets a
5-second request deadline. Standard `serve` streams through the HTTP boundary.
The deployment adapters still buffer bodies but now transport arbitrary bytes
without UTF-8 replacement.

```sh
just binary-http-test
```

This compiles the component, runs it through both the spawned CLI and daemon JSON
invocation adapters, and checks every possible byte value. It also checks legacy
text compatibility and rejects ambiguous or malformed body encodings.
