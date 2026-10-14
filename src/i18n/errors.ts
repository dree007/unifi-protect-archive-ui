import type { Translator } from "./core";

/** Only bounded technical codes are displayed; diagnostics and paths stay in server logs. */
export function operationError(message: string | null, t: Translator): string {
  const code = message?.match(/\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|EACCES|ENOENT|SQLSTATE [0-9A-Z]{5})\b/)?.[0];
  return t("errors.operation") + (code ? ` (${code})` : "");
}
