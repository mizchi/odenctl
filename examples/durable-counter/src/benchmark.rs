use crate::bindings::oden::durable::objects;
use futures::{StreamExt, TryStreamExt, stream};
use std::time::Instant;

struct Options {
    binding: String,
    prefix: String,
    increment: bool,
    iterations: usize,
    warmup: usize,
    concurrency: usize,
    objects: usize,
}

impl Options {
    fn parse() -> Result<Self, String> {
        let args: Vec<_> = std::env::args().collect();
        if args.len() != 8 {
            return Err(
                "expected: binding prefix read|increment iterations warmup concurrency objects"
                    .into(),
            );
        }
        let number = |index: usize, min: usize, max: usize| {
            args[index]
                .parse::<usize>()
                .ok()
                .filter(|n| (min..=max).contains(n))
                .ok_or_else(|| format!("argument {index} must be {min}..{max}"))
        };
        let increment = match args[3].as_str() {
            "read" => false,
            "increment" => true,
            _ => return Err("workload must be read or increment".into()),
        };
        if args[2].is_empty() || args[2].len() > 80 {
            return Err("object prefix must be 1..80 bytes".into());
        }
        Ok(Self {
            binding: args[1].clone(),
            prefix: args[2].clone(),
            increment,
            iterations: number(4, 1, 1_000_000)?,
            warmup: number(5, 0, 1_000_000)?,
            concurrency: number(6, 1, 1024)?,
            objects: number(7, 1, 1024)?,
        })
    }
}

async fn fetch(object: &objects::Object, id: Option<String>) -> Result<u64, String> {
    let response = object
        .fetch(objects::Request {
            method: if id.is_some() { "POST" } else { "GET" }.into(),
            path: if id.is_some() { "/increment" } else { "/" }.into(),
            headers: vec![],
            body: vec![],
            request_id: id,
        })
        .await
        .map_err(|error| format!("fetch: {error:?}"))?;
    if response.status != 200 {
        let detail: String = String::from_utf8_lossy(&response.body)
            .chars()
            .take(256)
            .collect();
        return Err(format!("actor status {}: {detail}", response.status));
    }
    serde_json::from_slice::<serde_json::Value>(&response.body)
        .map_err(|error| error.to_string())?["n"]
        .as_u64()
        .ok_or_else(|| "actor returned an invalid counter".into())
}

async fn batch(
    options: &Options,
    objects: &[objects::Object],
    phase: &str,
    count: usize,
) -> Result<Vec<f64>, String> {
    stream::iter(0..count)
        .map(|index| async move {
            let started = Instant::now();
            let id = options
                .increment
                .then(|| format!("{}:{phase}:{index}", options.prefix));
            let n = fetch(&objects[index % objects.len()], id).await?;
            if (options.increment && n == 0) || (!options.increment && n != 0) {
                return Err(format!("unexpected counter {n}"));
            }
            Ok(started.elapsed().as_secs_f64() * 1000.0)
        })
        .buffer_unordered(options.concurrency)
        .try_collect()
        .await
}

pub async fn run() -> Result<(), String> {
    let options = Options::parse()?;
    let objects = (0..options.objects)
        .map(|index| {
            objects::open(&options.binding, &format!("{}-{index}", options.prefix))
                .map_err(|error| format!("open: {error:?}"))
        })
        .collect::<Result<Vec<_>, _>>()?;

    let warmup_started = Instant::now();
    batch(&options, &objects, "warmup", options.warmup).await?;
    let warmup_elapsed_ms = warmup_started.elapsed().as_secs_f64() * 1000.0;
    let started = Instant::now();
    let latencies = batch(&options, &objects, "measured", options.iterations).await?;
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;

    // Outside the timed batch: verify every update reached persistent state.
    // This also catches reused request IDs accidentally benchmarking dedup hits.
    let mut verified_count = 0;
    for (index, object) in objects.iter().enumerate() {
        let assigned =
            |count: usize| count / objects.len() + usize::from(index < count % objects.len());
        let expected = if options.increment {
            assigned(options.warmup) + assigned(options.iterations)
        } else {
            0
        };
        let actual = fetch(object, None).await?;
        if actual != expected as u64 {
            return Err(format!(
                "counter {index}: expected {expected}, got {actual}"
            ));
        }
        verified_count += actual;
    }
    println!(
        "{}",
        serde_json::json!({
            "schemaVersion": 1, "latenciesMs": latencies, "elapsedMs": elapsed_ms,
            "warmupCount": options.warmup, "warmupElapsedMs": warmup_elapsed_ms,
            "verifiedCount": verified_count,
        })
    );
    Ok(())
}
