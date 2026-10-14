/** Minimal logger for the Protect commands; implementations must never print secrets. */
export interface ProtectLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Only with --verbose (e.g. every received event). */
  debug(message: string): void;
}

export const silentProtectLogger: ProtectLogger = { info() {}, warn() {}, error() {}, debug() {} };
