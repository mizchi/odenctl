export type RuntimeShutdownSignal = "SIGTERM" | "SIGINT";

export interface RuntimeShutdownProcess {
  once(signal: RuntimeShutdownSignal, listener: () => void): unknown;
  exit(code?: number): unknown;
}

export interface RuntimeShutdownLogger {
  log(message: string): void;
  error(message: string): void;
}

export interface RuntimeShutdownOptions {
  close(): Promise<void>;
  process?: RuntimeShutdownProcess;
  logger?: RuntimeShutdownLogger;
  signals?: RuntimeShutdownSignal[];
}

export function installRuntimeShutdownHandlers(options: RuntimeShutdownOptions) {
  const runtimeProcess = options.process ?? process;
  const logger = options.logger ?? console;
  const signals = options.signals ?? ["SIGTERM", "SIGINT"];
  let shuttingDown = false;

  function shutdown(signal: RuntimeShutdownSignal) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.log(`runtime received ${signal}; draining active invocations`);
    void options.close().then(
      () => {
        runtimeProcess.exit(0);
      },
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`runtime shutdown failed: ${message}`);
        runtimeProcess.exit(1);
      },
    );
  }

  for (const signal of signals) {
    runtimeProcess.once(signal, () => shutdown(signal));
  }

  return { shutdown };
}
