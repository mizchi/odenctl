import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

/** An owned local runtime process. Readiness means its listener and lifecycle are ready. */
export async function startServiceProcess(host: string, args: string[], env = process.env, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const started = performance.now();
  const child = spawn(host, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const abort = () => { child.kill("SIGTERM"); };
  signal?.addEventListener("abort", abort, { once: true });
  let logs = "";
  child.stdout.on("data", () => {});
  child.stderr.on("data", (chunk) => { logs = (logs + chunk.toString()).slice(-16_384); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: null, signal: null }));
  });
  let stopping: ReturnType<typeof stopInner> | undefined;
  async function stopInner() {
    const start = performance.now();
    let forced = false;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const timer = setTimeout(() => { forced = true; child.kill("SIGKILL"); }, 5000);
    const result = await exited;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    let pidAlive = false;
    if (child.pid) { try { process.kill(child.pid, 0); pidAlive = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
    return { durationMs: performance.now() - start, exitCode: result.code, signal: result.signal, forced, pidAlive };
  }
  const stop = () => stopping ??= stopInner();
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`runtime startup timeout: ${logs}`)), 20_000);
      child.stderr.on("data", () => {
        const match = /listening on (http:\/\/[^\s]+)\r?\n/.exec(logs);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error(`runtime exited during startup: ${logs}`)); });
    });
    return { url, child, pid: child.pid!, startupMs: performance.now() - started, stop, logs: () => logs };
  } catch (error) { await stop(); throw error; }
}
