import type { ProtectLogger } from "@/server/protect/logger";

/** Worker log lines go to stdout/stderr (container logs); same shape as the Protect logger. */
export type WorkerLogger = ProtectLogger;

export const silentWorkerLogger: WorkerLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** Timestamped console logger; `debug` only with `verbose`. Must never be given secrets. */
export function createConsoleLogger({ verbose = false } = {}): WorkerLogger {
  const time = () => new Date().toISOString();
  return {
    info: (message) => console.log(`${time()}  ${message}`),
    warn: (message) => console.warn(`${time()}  WARN  ${message}`),
    error: (message) => console.error(`${time()}  ERROR ${message}`),
    debug: (message) => {
      if (verbose) console.log(`${time()}  ${message}`);
    },
  };
}

/** Prefixes every line, e.g. `[protect]`. */
export function withPrefix(logger: WorkerLogger, prefix: string): WorkerLogger {
  return {
    info: (message) => logger.info(`${prefix} ${message}`),
    warn: (message) => logger.warn(`${prefix} ${message}`),
    error: (message) => logger.error(`${prefix} ${message}`),
    debug: (message) => logger.debug(`${prefix} ${message}`),
  };
}
