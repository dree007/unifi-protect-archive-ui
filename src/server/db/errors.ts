import { DatabaseError } from "pg";

/** PostgreSQL SQLSTATE codes the application reacts to. */
export const PgErrorCode = {
  uniqueViolation: "23505",
  foreignKeyViolation: "23503",
  checkViolation: "23514",
  notNullViolation: "23502",
} as const;

/** Finds the original `pg` error; Drizzle wraps driver errors in its own error types. */
export function findPgError(error: unknown): DatabaseError | undefined {
  let current: unknown = error;
  for (let depth = 0; current && depth < 10; depth++) {
    if (current instanceof DatabaseError) return current;
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

export function isPgError(
  error: unknown,
  code: (typeof PgErrorCode)[keyof typeof PgErrorCode],
  constraint?: string,
): boolean {
  const pgError = findPgError(error);
  return pgError?.code === code && (constraint === undefined || pgError.constraint === constraint);
}
