mod bindings {
    wit_bindgen::generate!({ path: "wit", world: "counter", generate_all });
}
#[cfg(feature = "benchmark")]
mod benchmark;
#[cfg(not(feature = "benchmark"))]
use bindings::oden::durable::objects;

struct CounterCommand;
bindings::export!(CounterCommand with_types_in bindings);

#[cfg(feature = "benchmark")]
impl bindings::exports::wasi::cli::run::Guest for CounterCommand {
    async fn run() -> Result<(), ()> {
        benchmark::run().await.map_err(|error| eprintln!("{error}"))
    }
}

#[cfg(not(feature = "benchmark"))]
impl bindings::exports::wasi::cli::run::Guest for CounterCommand {
    async fn run() -> Result<(), ()> {
        let args: Vec<_> = std::env::args().collect();
        let binding = args.get(1).map(String::as_str).unwrap_or("counter");
        let name = args.get(2).map(String::as_str).unwrap_or("default");
        let id = args.get(3).cloned();
        let object = objects::open(binding, name).map_err(|error| eprintln!("open: {error:?}"))?;
        let response = object
            .fetch(objects::Request {
                method: if id.is_some() { "POST" } else { "GET" }.into(),
                path: if id.is_some() { "/increment" } else { "/" }.into(),
                headers: vec![],
                body: vec![],
                request_id: id,
            })
            .await
            .map_err(|error| eprintln!("fetch: {error:?}"))?;
        println!("{}", String::from_utf8_lossy(&response.body));
        if response.status == 200 {
            Ok(())
        } else {
            Err(())
        }
    }
}
