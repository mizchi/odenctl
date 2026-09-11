import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { MVP_WORKER_WORLD } from "./control-plane/contracts.ts";

export const WORKER_TEMPLATE_LANGUAGES = ["rust"] as const;
export type WorkerTemplateLanguage = (typeof WORKER_TEMPLATE_LANGUAGES)[number];
export interface WorkerTemplateCatalogEntry {
  language: WorkerTemplateLanguage;
  world: typeof MVP_WORKER_WORLD;
  sdkFiles: string[];
  description: string;
}
export interface WorkerTemplateInput {
  language: WorkerTemplateLanguage;
  name: string;
  outDir?: string;
  force?: boolean;
}
export interface WorkerTemplateFile { path: string; contents: string; }
export interface WorkerTemplateResult {
  language: WorkerTemplateLanguage;
  name: string;
  outDir: string;
  world: typeof MVP_WORKER_WORLD;
  files: WorkerTemplateFile[];
  nextSteps: string[];
}
export function listWorkerTemplates(): WorkerTemplateCatalogEntry[] {
  return [{ language: "rust", world: MVP_WORKER_WORLD, sdkFiles: ["src/wasmplane.rs"], description: "Rust WASIp3 HTTP service with standard streaming bodies." }];
}
export async function workerTemplateFiles(input: WorkerTemplateInput): Promise<WorkerTemplateFile[]> {
  const name = workerName(input.name);
  if (input.language !== "rust") throw new Error(`unsupported worker template language ${input.language}`);
  return [
    { path: "Cargo.toml", contents: `[package]
name = "${name}"
version = "0.1.0"
edition = "2024"

[workspace]

[lib]
crate-type = ["cdylib"]

[dependencies]
wasip3 = { version = "=0.9.0", features = ["async-spawn"] }
` },
    { path: "src/lib.rs", contents: `mod wasmplane;
use wasip3::http::types::{ErrorCode, Request, Response};
struct App;
wasip3::http::service::export!(App);
impl wasip3::exports::http::handler::Guest for App {
    async fn handle(request: Request) -> Result<Response, ErrorCode> {
        Ok(wasmplane::text_response(format!("hello from ${name}: {}", request.get_path_with_query().unwrap_or_default())))
    }
}
` },
    { path: "src/wasmplane.rs", contents: `use wasip3::http::types::{Fields, Response};
use wasip3::{wit_bindgen, wit_future, wit_stream};
pub fn text_response(text: String) -> Response {
    let (mut writer, reader) = wit_stream::new();
    let (tx, trailers) = wit_future::new(|| Ok(None));
    drop(tx);
    let fields = Fields::new();
    fields.set("content-type", &[b"text/plain; charset=utf-8".to_vec()]).unwrap();
    let (response, _sent) = Response::new(fields, Some(reader), trailers);
    wit_bindgen::spawn_local(async move { let _ = writer.write_all(text.into_bytes()).await; });
    response
}
` },
    { path: "justfile", contents: `set shell := ["bash", "-cu"]

build:
    rustup target add wasm32-wasip2
    cargo build --target wasm32-wasip2

serve: build
    wasmplane serve target/wasm32-wasip2/debug/${rustCrateFileStem(name)}.wasm
` },
    { path: "README.md", contents: `# ${name}

Standard WASI HTTP service: ${MVP_WORKER_WORLD}.

Build with \`just build\`, then serve with \`just serve\` (wasmplane on PATH).
The wasip3 crate provides the standard bindings; no custom WIT generation is needed.
` },
  ];
}
export async function materializeWorkerTemplate(input: WorkerTemplateInput): Promise<WorkerTemplateResult> {
  const name = workerName(input.name);
  const outDir = input.outDir ?? name;
  const files = await workerTemplateFiles({ ...input, name });
  await assertCanWriteFiles(outDir, files, input.force === true);
  for (const file of files) {
    const target = join(outDir, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.contents);
  }
  return { language: input.language, name, outDir, world: MVP_WORKER_WORLD, files, nextSteps: ["cd <out-dir>", "just build"] };
}

async function assertCanWriteFiles(outDir: string, files: WorkerTemplateFile[], force: boolean): Promise<void> {
  if (force) {
    return;
  }
  for (const file of files) {
    const target = join(outDir, file.path);
    try {
      await access(target);
      throw new Error(`worker template target ${target} already exists; pass --force to overwrite`);
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
}

function workerName(value: string): string {
  const name = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    throw new Error("worker template name must start with an alphanumeric and contain only alphanumerics, dash, or underscore");
  }
  return name;
}

function rustCrateFileStem(name: string): string {
  return name.replaceAll("-", "_");
}
