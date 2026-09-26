// Typed application errors → mapped to the ApiError envelope in index.ts onError.

export class ApiException extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (message = "ไม่พบข้อมูล") =>
  new ApiException(404, "NOT_FOUND", message);

export const badRequest = (message: string, details?: unknown) =>
  new ApiException(400, "VALIDATION", message, details);

export const conflict = (code: string, message: string) =>
  new ApiException(409, code, message);

export const forbidden = (message = "ไม่มีสิทธิ์") =>
  new ApiException(403, "FORBIDDEN", message);

/**
 * THE error envelope — what `app.onError` answers for a thrown error, as `{ status, body }`.
 * TASK-490 — extracted so the shop-front BATCH reports each item's refusal with exactly the status and body the single
 * call would have answered (a batch of one is byte-identical to today BY CONSTRUCTION, not by a second copy of this).
 */
export function errorEnvelope(err: unknown): { status: number; body: { error: { code: string; message: string; details?: unknown } } } {
  if (err instanceof ApiException) return { status: err.status, body: { error: { code: err.code, message: err.message, details: err.details } } };
  const code = pgErrorCode(err);
  if (code === "23505") return { status: 409, body: { error: { code: "SLOT_TAKEN", message: "มีคาบในช่วงเวลานี้แล้ว" } } };
  if (code === "23503") return { status: 400, body: { error: { code: "VALIDATION", message: "ข้อมูลอ้างอิงไม่ถูกต้อง" } } };
  console.error(err);
  return { status: 500, body: { error: { code: "INTERNAL", message: "เกิดข้อผิดพลาดภายในระบบ" } } };
}

/**
 * Postgres SQLSTATE from an error. Drizzle wraps driver errors in
 * DrizzleQueryError, so the code lives on `.cause` — walk the chain to find it.
 */
export function pgErrorCode(e: any): string | undefined {
  let cur = e;
  for (let i = 0; i < 5 && cur; i++) {
    if (typeof cur.code === "string" && /^[0-9A-Z]{5}$/.test(cur.code)) return cur.code;
    cur = cur.cause;
  }
  return undefined;
}
