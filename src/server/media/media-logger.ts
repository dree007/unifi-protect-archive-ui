/**
 * Logger for the media endpoints. Only problems are logged (path violations, missing files,
 * permission errors, ffmpeg failures) – never one line per successful (range) request.
 * Real paths may appear here (server log), but never in a response.
 */
export interface MediaLogger {
  warn(message: string): void;
  error(message: string): void;
}

export const consoleMediaLogger: MediaLogger = {
  warn: (message) => console.warn(`[media] ${message}`),
  error: (message) => console.error(`[media] ${message}`),
};

export const silentMediaLogger: MediaLogger = { warn() {}, error() {} };
