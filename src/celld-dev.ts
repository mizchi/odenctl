import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

/** A disposable local celld instance. Never connects to an existing deployment. */
export async function startCelldDev(binary: string, signal?: AbortSignal) {
  const directory = await mkdtemp(join(tmpdir(), "odenctl-celld-bench-"));
  const token = randomBytes(32).toString("hex");
  let child: ChildProcess | undefined;
  const stop = async () => {
    try {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        const timer = setTimeout(() => child?.kill("SIGKILL"), 5000);
        try { await exited; } finally { clearTimeout(timer); }
      }
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  };
  try {
    signal?.throwIfAborted();
    await copyFile(new URL("../examples/celld-gateway/index.js", import.meta.url), join(directory, "index.js"));
    const config = JSON.parse(await readFile(new URL("../examples/celld-gateway/wrangler.jsonc", import.meta.url), "utf8"));
    config.vars.ODEN_GATEWAY_TOKEN = token;
    await writeFile(join(directory, "wrangler.jsonc"), JSON.stringify(config), { mode: 0o600 });
    const probe = createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const port = (probe.address() as import("node:net").AddressInfo).port;
    await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const endpoint = `http://127.0.0.1:${port}`;
    let logs = "";
    let startupError: Error | undefined;
    child = spawn(binary, ["dev", directory, "--port", String(port), "--no-watch", "--logs"], {
      env: { ...process.env, PATH: `${fileURLToPath(new URL("../node_modules/.bin", import.meta.url))}${delimiter}${process.env.PATH ?? ""}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", (error) => { startupError = error; });
    const log = (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-16_384); };
    child.stdout!.on("data", log);
    child.stderr!.on("data", log);
    const deadline = performance.now() + 20_000;
    while (performance.now() < deadline) {
      signal?.throwIfAborted();
      if (startupError) throw startupError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`celld exited during startup: ${logs}`);
      try {
        const response = await fetch(endpoint, { signal: AbortSignal.timeout(300) });
        await response.arrayBuffer();
        if (response.status === 401) return { directory, endpoint, token, stop, logs: () => logs };
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`celld did not become ready: ${logs}`);
  } catch (error) {
    await stop();
    throw error;
  }
}
