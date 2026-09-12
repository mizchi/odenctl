///|
/// Buffered helpers use the host's explicit grants; errors retain WASI detail.
pub(all) enum IoError {
  InvalidPath
  NotPreopened
  BodyTooLarge
  File(@fs.ErrorCode)
  Http(@types.ErrorCode)
  InvalidRequest
  Header(@types.HeaderError)
}

///|
pub fn env(name : String) -> String? {
  for (key, value) in @environment.get_environment() {
    if key == name {
      return Some(value)
    }
  }
  None
}

///|
async fn open_file(
  path : String,
  write : Bool,
) -> Result[@fs.Descriptor, IoError] {
  if !path.has_prefix("/") || path.contains("\u0000") {
    return Err(InvalidPath)
  }
  for part in path.split("/") {
    if part == ".." || part == "." {
      return Err(InvalidPath)
    }
  }
  let directories = @preopens.get_directories()
  defer (for (directory, _) in directories {
    directory.drop()
  })
  let mut selected = -1
  let mut length = -1
  for index, (_, root) in directories {
    let prefix = if root.has_suffix("/") { root } else { root + "/" }
    if path.has_prefix(prefix) && prefix.length() >= length {
      selected = index
      length = prefix.length()
    }
  }
  if selected < 0 {
    return Err(NotPreopened)
  }
  let (directory, _) = directories[selected]
  let flags = if write {
    @fs.OpenFlags::default().set(CREATE).set(TRUNCATE)
  } else {
    @fs.OpenFlags::default()
  }
  let access = if write {
    @fs.DescriptorFlags::default().set(WRITE)
  } else {
    @fs.DescriptorFlags::default().set(READ)
  }
  directory
  .open_at(@fs.PathFlags::default(), path[length:].to_owned(), flags, access)
  .map_err(fn(error) { File(error) })
}

///|
async fn read_bounded(
  stream : @async-core.Stream[Byte],
  limit : Int,
) -> Result[Bytes, IoError] {
  defer stream.drop_sync()
  if limit < 0 {
    return Err(BodyTooLarge)
  }
  let output = Buffer()
  let mut length = 0
  while true {
    let count = if limit - length >= 16384 { 16384 } else { limit - length + 1 }
    match stream.read(count) {
      None => return Ok(output.to_bytes())
      Some(chunk) => {
        if chunk.length() > limit - length {
          return Err(BodyTooLarge)
        }
        length += chunk.length()
        output.write_bytes(Bytes::from_array(chunk[:])[:])
      }
    }
  } nobreak {
    abort("unreachable")
  }
}

///|
pub async fn read_file(path : String, limit : Int) -> Result[Bytes, IoError] {
  let file = match open_file(path, false) {
    Ok(file) => file
    Err(error) => return Err(error)
  }
  defer file.drop()
  let (stream, finished) = file.read_via_stream(0UL)
  defer finished.drop_sync()
  let bytes = match read_bounded(stream, limit) {
    Ok(bytes) => bytes
    Err(error) => return Err(error)
  }
  match finished.get() {
    Ok(_) => Ok(bytes)
    Err(error) => Err(File(error))
  }
}

///|
pub async fn write_file(path : String, bytes : Bytes) -> Result[Unit, IoError] {
  let file = match open_file(path, true) {
    Ok(file) => file
    Err(error) => return Err(error)
  }
  defer file.drop()
  let stream = @async-core.Stream::produce(async fn(sink) {
    ignore(sink.write_all_bytes(bytes[:]))
    sink.close()
  })
  let finished = file.write_via_stream(stream, 0UL)
  defer finished.drop_sync()
  finished.get().map_err(fn(error) { File(error) })
}

///|
pub(all) struct HttpRequest {
  method_ : @types.Method
  scheme : @types.Scheme
  authority : String
  path : String
  headers : Array[(String, FixedArray[Byte])]
  body : Bytes
}

///|
pub(all) struct HttpResponse {
  status : UInt
  headers : Array[(String, FixedArray[Byte])]
  body : Bytes
}

///|
pub async fn fetch(
  input : HttpRequest,
  limit : Int,
) -> Result[HttpResponse, IoError] {
  let headers = match @types.Fields::from_list(input.headers) {
    Ok(headers) => headers
    Err(error) => return Err(Header(error))
  }
  let stream = @async-core.Stream::produce(async fn(sink) {
    ignore(sink.write_all_bytes(input.body[:]))
    sink.close()
  })
  let (request, sent) = @types.Request::new(
    headers,
    Some(stream),
    @async-core.Future::ready(Ok(None)),
    None,
  )
  defer sent.drop_sync()
  if request.set_method(input.method_) is Err(_) ||
    request.set_scheme(Some(input.scheme)) is Err(_) ||
    request.set_authority(Some(input.authority)) is Err(_) ||
    request.set_path_with_query(Some(input.path)) is Err(_) {
    request.drop()
    return Err(InvalidRequest)
  }
  let response = match @client.send(request) {
    Ok(response) => response
    Err(error) => return Err(Http(error))
  }
  let status = response.get_status_code()
  let fields = response.get_headers()
  defer fields.drop()
  let headers = fields.copy_all()
  let (stream, trailers) = @types.Response::consume_body(
    response,
    @async-core.Future::ready(Ok(())),
  )
  defer trailers.drop_sync()
  let body = match read_bounded(stream, limit) {
    Ok(body) => body
    Err(error) => return Err(error)
  }
  match trailers.get() {
    Err(error) => return Err(Http(error))
    Ok(Some(fields)) => fields.drop()
    Ok(None) => ()
  }
  match sent.get() {
    Err(error) => Err(Http(error))
    Ok(_) => Ok({ status, headers, body, })
  }
}

///|
/// The handle is released after one dispatch. Unknown outcomes are never retried.
pub async fn durable_fetch(
  binding : String,
  name : String,
  request : @objects.Request,
) -> Result[@objects.Response, @objects.Error_] {
  let object = match @objects.open(binding, name) {
    Ok(object) => object
    Err(error) => return Err(error)
  }
  defer object.drop()
  object.fetch(request)
}
