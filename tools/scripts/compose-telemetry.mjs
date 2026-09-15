// Generate a typed WIT boundary wrapper, build it, and compose it with its provider.
// No binary rewriting: the checked WIT contract drives regenerable Rust bindings.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const snake = (name) => name.replaceAll("-", "_");
const ident = (name) => `r#${snake(name)}`;
const camel = (name) =>
  name.split("-").map((s) => s[0].toUpperCase() + s.slice(1)).join("");
const modulePath = (graph, id) => {
  const iface = graph.interfaces[id];
  return graph.packages[iface.package].name.split("@")[0].split(":").concat(
    iface.name,
  ).map(ident).join("::");
};
function canonical(graph, id) {
  const iface = graph.interfaces[id];
  const [pkg, version] = graph.packages[iface.package].name.split("@");
  return `${pkg}/${iface.name}${version ? `@${version}` : ""}`;
}

export function generateWrapper(
  graph,
  selected,
  bindings,
  contextParam = "context",
) {
  const ifaceId = graph.interfaces.findIndex((_, id) =>
    canonical(graph, id) === selected
  );
  if (ifaceId < 0) throw new Error(`Interface not found: ${selected}`);
  const iface = graph.interfaces[ifaceId];
  const path = modulePath(graph, ifaceId);
  const tracingId = graph.interfaces.findIndex((_, id) =>
    canonical(graph, id) === "oden:telemetry/tracing@0.1.0"
  );
  function ultimate(type) {
    return typeof type === "number" && graph.types[type].kind.type !== undefined
      ? ultimate(graph.types[type].kind.type)
      : type;
  }
  function validate(type) {
    if (type == null || typeof type === "string") return;
    const kind = graph.types[type].kind;
    if (kind.type !== undefined) return validate(kind.type);
    if (kind.record) return kind.record.fields.forEach((f) => validate(f.type));
    if (kind.enum) return;
    if (kind.variant) {
      return kind.variant.cases.forEach((c) => validate(c.type));
    }
    if (kind.list !== undefined) return validate(kind.list);
    if (kind.option !== undefined) return validate(kind.option);
    if (kind.result) {
      validate(kind.result.ok);
      return validate(kind.result.err);
    }
    if (kind.tuple) return kind.tuple.types.forEach(validate);
    throw new Error(
      "Wrapper supports value types only; resources, flags, streams and futures require a lifetime-aware adapter",
    );
  }
  function convert(type, value, direction) {
    if (type == null || typeof type === "string") return value;
    const t = graph.types[type], k = t.kind;
    if (k.type !== undefined) return convert(k.type, value, direction);
    const owner = t.owner?.interface;
    // Foreign types have a single generated identity shared by both interfaces.
    if (owner !== undefined && owner !== ifaceId) return value;
    const from = direction === "in" ? "output" : "input",
      to = direction === "in" ? "input" : "output";
    if (k.record) {
      return `${to}::${camel(t.name)} { ${
        k.record.fields.map((f) =>
          `${ident(f.name)}: ${
            convert(f.type, `${value}.${ident(f.name)}`, direction)
          }`
        ).join(", ")
      } }`;
    }
    if (k.enum) {
      return `match ${value} { ${
        k.enum.cases.map((c) =>
          `${from}::${camel(t.name)}::${camel(c.name)} => ${to}::${
            camel(t.name)
          }::${camel(c.name)}`
        ).join(", ")
      } }`;
    }
    if (k.variant) {
      return `match ${value} { ${
        k.variant.cases.map((c) =>
          `${from}::${camel(t.name)}::${camel(c.name)}${
            c.type == null ? "" : "(v)"
          } => ${to}::${camel(t.name)}::${camel(c.name)}${
            c.type == null ? "" : `(${convert(c.type, "v", direction)})`
          }`
        ).join(", ")
      } }`;
    }
    if (k.list !== undefined) {
      return `${value}.into_iter().map(|v| ${
        convert(k.list, "v", direction)
      }).collect::<Vec<_>>()`;
    }
    if (k.option !== undefined) {
      return `${value}.map(|v| ${convert(k.option, "v", direction)})`;
    }
    if (k.result) {
      return `${value}.map(|v| ${
        convert(k.result.ok, "v", direction)
      }).map_err(|v| ${convert(k.result.err, "v", direction)})`;
    }
    if (k.tuple) {
      return `(${
        k.tuple.types.map((t, i) => convert(t, `${value}.${i}`, direction))
          .join(", ")
      },)`;
    }
    throw new Error("Unsupported conversion");
  }
  const functions = Object.values(iface.functions);
  const implementations = functions.map((fn) => {
    if (!["freestanding", "async-freestanding"].includes(fn.kind)) {
      throw new Error("Resource methods cannot be wrapped as value calls");
    }
    fn.params.forEach((p) => validate(p.type));
    validate(fn.result);
    const name = snake(fn.name), async = fn.kind === "async-freestanding";
    const occupied = new Set(fn.params.map((p) => snake(p.name)));
    const local = (base) => {
      while (occupied.has(base)) base += "_";
      occupied.add(base);
      return base;
    };
    const spanName = local("odenctl_span"),
      resultName = local("odenctl_result");
    const trait = new RegExp(
      `(?:async\\s+)?fn (?:r#)?${name}\\(([^;{]*?)\\)\\s*(->[^;{]+)?;`,
    ).exec(bindings.slice(bindings.lastIndexOf("pub trait Guest")));
    if (!trait) throw new Error(`Generated trait signature not found: ${name}`);
    const signature = trait[1], resultType = trait[2] ?? "";
    const imports = new RegExp(
      `pub\\s+(?:async\\s+)?fn (?:r#)?${name}\\(([^]*?)\\)`,
    ).exec(bindings)?.[1];
    if (imports == null) {
      throw new Error(`Generated import signature not found: ${name}`);
    }
    const parent = fn.params.find((p) => p.name === contextParam);
    if (parent) {
      const type = graph.types[ultimate(parent.type)];
      if (type?.name !== "context" || type.owner?.interface !== tracingId) {
        throw new Error(
          `${contextParam} must use oden:telemetry/tracing.context`,
        );
      }
    }
    const params = fn.params.map((p) => {
      const n = ident(p.name);
      const v = convert(p.type, n, "in");
      const borrow = new RegExp(`(?:r#)?${snake(p.name)}\\s*:\\s*&`).test(
        imports,
      );
      return borrow ? `&(${v})` : v;
    });
    const sourceName = JSON.stringify(`${selected}#${fn.name}`);
    // Reparent the forwarded explicit context to the boundary span itself.
    return `${async ? "async " : ""}fn ${
      ident(fn.name)
    }(${signature}) ${resultType} {
      let ${spanName} = telemetry::start_span(${
      parent ? `Some(&${ident(parent.name)})` : "None"
    }, ${sourceName});
      ${
      parent
        ? `let ${
          ident(parent.name)
        } = ${spanName}.as_ref().map(|s| s.context()).unwrap_or(${
          ident(parent.name)
        });`
        : ""
    }
      let ${resultName} = input::${ident(fn.name)}(${params.join(", ")})${
      async ? ".await" : ""
    };
      if let Some(span) = ${spanName} { span.end(${
      typeof fn.result === "number" &&
        graph.types[ultimate(fn.result)].kind.result
        ? `if ${resultName}.is_err() { telemetry::Outcome::Error } else { telemetry::Outcome::Ok }`
        : "telemetry::Outcome::Ok"
    }); }
      ${convert(fn.result, resultName, "out")}
    }`;
  });
  return `mod telemetry_wrapper;
mod _rt { pub use std::{string::String, vec::Vec}; }
use telemetry_wrapper as bindings;
use bindings::${path} as input;
use bindings::exports::${path} as output;
use output::*;
use bindings::oden::telemetry::tracing as telemetry;
struct Wrapper;
impl output::Guest for Wrapper { ${implementations.join("\n")} }
bindings::export!(Wrapper with_types_in bindings);
`;
}

export function compose(options) {
  const {
    provider,
    interface: selected,
    output,
    app,
    contextParam = "context",
  } = options;
  if (!provider || !selected || !output) {
    throw new Error(
      "Required: --provider component.wasm --interface namespace:package/interface[@version] --output composed.wasm [--app app.wasm] [--context-param context]",
    );
  }
  const out = resolve(output);
  mkdirSync(dirname(out), { recursive: true });
  const work = mkdtempSync(join(dirname(out), "telemetry-wrapper-"));
  const wit = join(work, "wit"), src = join(work, "src");
  mkdirSync(src);
  function run(tool, args) {
    const r = spawnSync(tool, args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`${tool}: ${r.stderr || r.stdout}`);
    return r.stdout;
  }
  const wac = process.env.WAC ?? "wac",
    bindgen = process.env.WIT_BINDGEN ?? "wit-bindgen";
  const graph = JSON.parse(
    run("wasm-tools", ["component", "wit", resolve(provider), "--json"]),
  );
  // Fail before building if the selected interface is not actually exported.
  const id = graph.interfaces.findIndex((_, id) =>
    canonical(graph, id) === selected
  );
  if (
    id < 0 ||
    !graph.worlds.some((w) =>
      Object.values(w.exports).some((e) => e.interface?.id === id)
    )
  ) throw new Error(`Provider does not export ${selected}`);
  run("wasm-tools", ["component", "wit", resolve(provider), "--out-dir", wit]);
  const rootFile = join(wit, "component.wit");
  if (existsSync(rootFile)) {
    mkdirSync(join(wit, "deps"), { recursive: true });
    renameSync(rootFile, join(wit, "deps", "provider-root.wit"));
  }
  // wasm-tools may use the source package name for a WIT input; component binaries use component.wit.
  writeFileSync(
    rootFile,
    `package oden:boundary-wrapper;\nworld telemetry-wrapper { import ${selected}; export ${selected}; import oden:telemetry/tracing@0.1.0; }\n`,
  );
  // A compiled provider often imports only context/log. Expand that subset to
  // the same version's complete contract so the wrapper can also create spans.
  const telemetryFile = readdirSync(wit, { recursive: true }).filter((name) =>
    name.endsWith(".wit")
  ).map((name) => join(wit, name)).find((path) =>
    readFileSync(path, "utf8").includes("package oden:telemetry@0.1.0;")
  );
  cpSync(
    join(root, "sdk/rust/wit/telemetry.wit"),
    telemetryFile ?? join(wit, "deps", "telemetry.wit"),
  );
  run(bindgen, [
    "rust",
    wit,
    "--world",
    "telemetry-wrapper",
    "--generate-all",
    "--out-dir",
    src,
  ]);
  const wrapperGraph = JSON.parse(
    run("wasm-tools", ["component", "wit", wit, "--json"]),
  );
  const bindings = readFileSync(join(src, "telemetry_wrapper.rs"), "utf8");
  const source = generateWrapper(
    wrapperGraph,
    selected,
    bindings,
    contextParam,
  );
  writeFileSync(join(src, "lib.rs"), source);
  // Share dependency builds, but keep distinct wrappers' artifacts independent.
  const library = "odenctl_boundary_" +
    createHash("sha256").update(bindings).update(source).digest("hex").slice(
      0,
      24,
    );
  writeFileSync(
    join(work, "Cargo.toml"),
    `[package]\nname="odenctl-boundary-wrapper"\nversion="0.1.0"\nedition="2024"\n[workspace]\n[lib]\nname="${library}"\ncrate-type=["cdylib"]\n[dependencies]\nwit-bindgen={version="=0.62.0",features=["async"]}\n`,
  );
  run("cargo", [
    "build",
    "--manifest-path",
    join(work, "Cargo.toml"),
    "--target",
    "wasm32-wasip2",
    "--target-dir",
    join(root, "target/telemetry-wrapper-build"),
  ]);
  const wasm = join(
    root,
    `target/telemetry-wrapper-build/wasm32-wasip2/debug/${library}.wasm`,
  );
  const wrapped = join(work, "wrapped.wasm");
  run(wac, ["plug", wasm, "--plug", resolve(provider), "-o", wrapped]);
  if (app) run(wac, ["plug", resolve(app), "--plug", wrapped, "-o", out]);
  else cpSync(wrapped, out);
  run("wasm-tools", [
    "validate",
    "--features",
    "cm-async,cm-async-stackful",
    out,
  ]);
  writeFileSync(
    out + ".telemetry.json",
    JSON.stringify(
      {
        version: 1,
        interface: selected,
        provider: resolve(provider),
        app: app ? resolve(app) : null,
        source: work,
        contextParam,
        completion: "function result; resource/stream interfaces are rejected",
      },
      null,
      2,
    ) + "\n",
  );
  return { output: out, source: work };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i];
      if (
        !["--provider", "--interface", "--output", "--app", "--context-param"]
          .includes(key) || !args[i + 1]
      ) throw new Error(`Invalid argument: ${key}`);
      options[key === "--context-param" ? "contextParam" : key.slice(2)] =
        args[i + 1];
    }
    console.log(JSON.stringify(compose(options)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
