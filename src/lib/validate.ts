// TASK-296 (DEF-5) — 🔴 **every validation refusal in this product reached the admin as a raw zod array.**
//
// `@hono/zod-validator` answers the request ITSELF on a refusal, so `app.onError` (`index.ts`) — the handler
// that turns `ApiException`, `23505` and `23503` into Thai sentences — **was never on that path at all.** The
// `ZodError`'s `.message` is the JSON-stringified issue list, `TIME`'s regex source included; the FE read
// `body.error` and rendered `.message` in the red box, **which is exactly what it should do.**
// ⇒ 🔑 **Nobody chose to show that. There is no line anywhere that decided to.**
//
// 📌 It went unseen because our forms normally gate the button — DEF-5 is simply the first time one let a bad
// value through. **The owner did not find a resume defect; he found the first door onto a hole that was always
// there**, on every screen in the product.
//
// 🔑 **This module exists so the fix cannot be forgotten on the next route.** Every router imports `zValidator`
// from HERE rather than from the library, and this one supplies the hook. A route added tomorrow with the same
// two arguments everyone already writes is covered by construction — 🚫 **a hook passed per call site is the
// thing that rots on the route nobody edits.**
import type { ValidationTargets } from "hono";
import { zValidator as zodValidator } from "@hono/zod-validator";

type Schema = Parameters<typeof zodValidator>[1];

/**
 * ⚠️ **One sentence, read by an admin, in Thai — like every other message `onError` emits.**
 *
 * 🚫 It names **no field, no type and no regex**, and that is the requirement rather than a style choice: the
 * FORM is what says which field is wrong, in the admin's own words, next to the field. A server sentence that
 * tried to do the form's job would be a second, worse copy of it — in the wrong language, out of position.
 */
export const VALIDATION_MESSAGE = "ข้อมูลที่กรอกไม่ถูกต้อง กรุณาตรวจสอบแล้วลองใหม่อีกครั้ง";

/**
 * The refusal, in the envelope `index.ts` already emits for `23503`: `code: "VALIDATION"`, 400.
 * ✅ **Not a new envelope — one path being stopped from escaping the existing one.**
 *
 * 🔑 The issues ride in `details`, never in `message`. `ApiClientError` carries `details` deliberately, the red
 * box does not render it, and **an engineer reading a network tab is the right reader for an issue array.**
 */
export function zValidator<T extends Schema, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
) {
  return zodValidator(target, schema, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION",
            message: VALIDATION_MESSAGE,
            details: (result.error as { issues?: unknown }).issues ?? [],
          },
        },
        400,
      );
    }
  });
}
