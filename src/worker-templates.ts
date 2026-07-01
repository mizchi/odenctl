import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const WORKER_TEMPLATE_LANGUAGES = ["rust", "typescript"] as const;
export type WorkerTemplateLanguage = (typeof WORKER_TEMPLATE_LANGUAGES)[number];

export interface WorkerTemplateCatalogEntry {
  language: WorkerTemplateLanguage;
  world: "myedge:runtime/worker@0.1.0";
  sdkFiles: string[];
  description: string;
}

export interface WorkerTemplateInput {
  language: WorkerTemplateLanguage;
  name: string;
  outDir?: string;
  force?: boolean;
  witPath?: string;
}

export interface WorkerTemplateFile {
  path: string;
  contents: string;
}

export interface WorkerTemplateResult {
  language: WorkerTemplateLanguage;
  name: string;
  outDir: string;
  world: "myedge:runtime/worker@0.1.0";
  files: WorkerTemplateFile[];
  nextSteps: string[];
}

const workerWorld = "myedge:runtime/worker@0.1.0" as const;
const defaultWitPath = new URL("../wit/myedge-runtime.wit", import.meta.url);

export function listWorkerTemplates(): WorkerTemplateCatalogEntry[] {
  return [
    {
      language: "rust",
      world: workerWorld,
      sdkFiles: ["src/wasmplane.rs", "wit/world.wit"],
      description: "Rust component template using wit-bindgen async bindings.",
    },
    {
      language: "typescript",
      world: workerWorld,
      sdkFiles: ["src/wasmplane.ts", "wit/world.wit"],
      description: "TypeScript component template intended for jco componentize.",
    },
  ];
}

export async function workerTemplateFiles(input: WorkerTemplateInput): Promise<WorkerTemplateFile[]> {
  const name = workerName(input.name);
  const wit = await readFile(input.witPath ?? defaultWitPath, "utf8");
  switch (input.language) {
    case "rust":
      return rustWorkerTemplate(name, wit);
    case "typescript":
      return typescriptWorkerTemplate(name, wit);
    default:
      assertNever(input.language);
  }
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
  return {
    language: input.language,
    name,
    outDir,
    world: workerWorld,
    files,
    nextSteps: nextSteps(input.language),
  };
}

function rustWorkerTemplate(name: string, wit: string): WorkerTemplateFile[] {
  return [
    {
      path: "Cargo.toml",
      contents: `[package]
name = "${name}"
version = "0.1.0"
edition = "2024"

[dependencies]
wit-bindgen = { version = "0.51.0", features = ["async", "bitflags"] }

[lib]
crate-type = ["cdylib"]

[package.metadata.component]
package = "myedge:${name}"
`,
    },
    {
      path: "wit/world.wit",
      contents: wit,
    },
    {
      path: "src/wasmplane.rs",
      contents: `use crate::bindings::myedge::runtime::http::{new_outgoing_body, OutgoingBody, Request, Response};
use crate::bindings::myedge::runtime::types::{Header, ResponseHead};

pub async fn text_response(status: u16, body_text: impl Into<String>) -> Response {
    let body = new_outgoing_body().await;
    OutgoingBody::write(&body, body_text.into().into_bytes()).await;
    OutgoingBody::finish(&body).await;
    Response {
        head: ResponseHead {
            status,
            headers: vec![Header {
                name: "content-type".to_string(),
                value: "text/plain; charset=utf-8".to_string(),
            }],
        },
        body,
    }
}

pub fn header(req: &Request, name: &str) -> Option<String> {
    req.head
        .headers
        .iter()
        .find(|header| header.name.eq_ignore_ascii_case(name))
        .map(|header| header.value.clone())
}
`,
    },
    {
      path: "src/lib.rs",
      contents: `#[allow(warnings)]
mod bindings;
mod wasmplane;

use bindings::Guest;
use bindings::myedge::runtime::http::{Request, Response};

struct Component;

impl Guest for Component {
    async fn handle(req: Request) -> Response {
        let message = format!("hello from ${name}: {} {}", req.head.method, req.head.uri);
        wasmplane::text_response(200, message).await
    }
}

bindings::export!(Component with_types_in bindings);
`,
    },
    {
      path: "justfile",
      contents: `set shell := ["zsh", "-cu"]

wasi_adapter := env_var_or_default("WASI_PREVIEW1_ADAPTER", "node_modules/@bytecodealliance/jco/lib/wasi_snapshot_preview1.reactor.wasm")
guest_wasm := "target/wasm32-wasip1/debug/${rustCrateFileStem(name)}.wasm"
guest_component := "target/wasm32-wasip1/debug/${rustCrateFileStem(name)}.component.wasm"

bindings:
    wit-bindgen rust wit --world worker --out-dir /tmp/${name}-wbg --async all
    cp /tmp/${name}-wbg/worker.rs src/bindings.rs

build: bindings
    cargo build --target wasm32-wasip1
    test -f "{{ wasi_adapter }}"
    wasm-tools component new "{{ guest_wasm }}" --adapt "{{ wasi_adapter }}" -o "{{ guest_component }}"
    wasm-tools component wit "{{ guest_component }}" >/dev/null
`,
    },
    {
      path: "README.md",
      contents: `# ${name}

Wasmplane Rust worker template for \`${workerWorld}\`.

## Build

\`\`\`sh
just build
\`\`\`
`,
    },
  ];
}

function typescriptWorkerTemplate(name: string, wit: string): WorkerTemplateFile[] {
  const packageJson = {
    name,
    private: true,
    type: "module",
    scripts: {
      build: "jco componentize src/worker.ts --wit wit/world.wit --world-name worker -o dist/worker.component.wasm",
    },
    devDependencies: {
      "@bytecodealliance/jco": "1.15.4",
      typescript: "^5.9.0",
    },
  };
  return [
    {
      path: "package.json",
      contents: `${JSON.stringify(packageJson, null, 2)}\n`,
    },
    {
      path: "wit/world.wit",
      contents: wit,
    },
    {
      path: "src/wasmplane.ts",
      contents: `export interface Header {
  name: string;
  value: string;
}

export interface ResponseHead {
  status: number;
  headers: Header[];
}

export interface ResponseLike {
  head: ResponseHead;
  body: Uint8Array;
}

export function textResponse(status: number, body: string): ResponseLike {
  return {
    head: {
      status,
      headers: [{ name: "content-type", value: "text/plain; charset=utf-8" }],
    },
    body: new TextEncoder().encode(body),
  };
}

export function header(headers: Header[], name: string): string | undefined {
  return headers.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value;
}
`,
    },
    {
      path: "src/worker.ts",
      contents: `import { textResponse } from "./wasmplane";

export async function handle(req: { head: { method: string; uri: string } }) {
  return textResponse(200, \`hello from ${name}: \${req.head.method} \${req.head.uri}\`);
}
`,
    },
    {
      path: "README.md",
      contents: `# ${name}

Wasmplane TypeScript worker template for \`${workerWorld}\`.

## Build

\`\`\`sh
pnpm install
pnpm build
\`\`\`
`,
    },
  ];
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

function nextSteps(language: WorkerTemplateLanguage): string[] {
  switch (language) {
    case "rust":
      return ["cd <out-dir>", "just build"];
    case "typescript":
      return ["cd <out-dir>", "pnpm install", "pnpm build"];
    default:
      assertNever(language);
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

function assertNever(value: never): never {
  throw new Error(`unsupported worker template language ${value}`);
}
