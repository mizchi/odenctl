///|
/// Shared conformance/demo routes for capability-based I/O.
async fn io_example(path : String) -> Json? {
  if !path.has_prefix("/io/") {
    return None
  }
  let value : Json = match path {
    "/io/env" =>
      {
        "value": @service.env("IO_VALUE").unwrap_or("").to_json(),
        "missing": (@service.env("UNGRANTED_ENV") is None).to_json(),
      }
    "/io/read" =>
      match @service.read_file("/data/input.txt", 1024) {
        Ok(bytes) => { "value": @utf8.decode(bytes).to_json() }
        Err(_) => { "error": "read failed" }
      }
    "/io/write" =>
      {
        "ok": (@service.write_file(
          "/data/output.txt",
          @utf8.encode("written 日本語"),
        )
        is Ok(_)).to_json(),
      }
    "/io/readonly" =>
      {
        "rejected": (@service.write_file("/readonly/output.txt", b"") is Err(_)).to_json(),
      }
    "/io/read-limit" =>
      {
        "rejected": (@service.read_file("/data/input.txt", 1)
        is Err(@service.BodyTooLarge)).to_json(),
      }
    "/io/escape" | "/io/parent" | "/io/missing" | "/io/ungranted" => {
      let file = match path {
        "/io/escape" => "/data/escape.txt"
        "/io/parent" => "/data/../outside.txt"
        "/io/missing" => "/data/missing.txt"
        _ => "/ungranted/file"
      }
      { "rejected": (@service.read_file(file, 1024) is Err(_)).to_json() }
    }
    "/io/fetch" | "/io/http-denied" | "/io/http-limit" => {
      let result = @service.fetch(
        {
          method_: Post,
          scheme: Http,
          authority: if path == "/io/http-denied" {
            @service.env("IO_DENIED_AUTHORITY").unwrap()
          } else {
            @service.env("IO_AUTHORITY").unwrap()
          },
          path: "/echo",
          headers: [("x-sdk", @utf8.encode("yes").to_fixedarray())],
          body: @utf8.encode("payload 日本語"),
        },
        if path == "/io/http-limit" {
          1
        } else {
          1024
        },
      )
      if path == "/io/fetch" {
        match result {
          Ok(response) => {
            let header = response.headers.any(fn(pair) {
              pair.0 == "x-upstream" &&
              @utf8.decode(Bytes::from_array(pair.1[:])) == "yes"
            })
            {
              "status": response.status.to_json(),
              "header": header.to_json(),
              "value": @utf8.decode(response.body).to_json(),
            }
          }
          Err(_) => { "error": "fetch failed" }
        }
      } else if path == "/io/http-limit" {
        { "rejected": (result is Err(@service.BodyTooLarge)).to_json() }
      } else {
        {
          "rejected": (result is Err(@service.Http(@types.HttpRequestDenied))).to_json(),
        }
      }
    }
    "/io/durable-denied" | "/io/durable" => {
      let result = @service.durable_fetch(
        if path == "/io/durable-denied" {
          "ungranted"
        } else {
          "counter"
        },
        "sdk-shared",
        {
          method_: "POST",
          path: "/increment",
          headers: [],
          body: [],
          request_id: None,
        },
      )
      if path == "/io/durable-denied" {
        { "rejected": (result is Err(@objects.BindingDenied)).to_json() }
      } else {
        match result {
          Ok(response) =>
            @json.parse(@utf8.decode(Bytes::from_array(response.body[:])))
          Err(_) => { "error": "durable failed" }
        }
      }
    }
    _ => { "error": "unknown I/O example" }
  }
  Some(value)
}
