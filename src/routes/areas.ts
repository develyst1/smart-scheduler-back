import { Hono } from "hono";
import { areaLevel, listDistricts, listProvinces, listSubDistricts } from "../lib/area-codes";

/**
 * TASK-800 (REQ-118, ruled B by @Sober 2026-10-12) — the AREA lists the two address pickers read (the LIFF registration page, the admin parent form):
 *
 *   GET /api/areas/provinces                         → [{ code, nameTh, nameEn }]   the 77
 *   GET /api/areas/districts?province=<2-digit code>     → [{ code, nameTh, nameEn }]   that province's districts / เขต
 *   GET /api/areas/subdistricts?district=<4-digit code>  → [{ code, nameTh, nameEn }]   that district's sub-districts / แขวง
 *
 * WHY HERE: the cross-check GATE (scripts/cross-check-area-codes.ts) proved the old picker package's geocodes wrong for ~21 % of its rows, so the back end — which owns the ONE dataset — answers the pickers. Every code
 * these routes return is accepted by the register / admin validation BY CONSTRUCTION (pinned by a test that walks all of them).
 *
 * PUBLIC (registered before the JWT guard, like \`publicRegister\`: the LIFF page has no admin token) — and safe to be: the answer is geography, an ALLOW-LIST of three fields per row, no personal data and no booking, rate or
 * account data of any kind. Cacheable: the file only changes with a deploy. A malformed or missing parent code ⇒ 400; a well-formed code the dataset does not know ⇒ an honest empty list.
 */
const CACHE = "public, max-age=3600, stale-while-revalidate=86400";
const bad = (c: any, what: string) => c.json({ ok: false, code: "VALIDATION", message: what }, 400);

export const publicAreas = new Hono()
  .get("/areas/provinces", (c) => {
    c.header("Cache-Control", CACHE);
    return c.json(listProvinces());
  })
  .get("/areas/districts", (c) => {
    const province = c.req.query("province") ?? "";
    if (areaLevel(province) !== "province") return bad(c, "province must be a 2-digit province code");
    c.header("Cache-Control", CACHE);
    return c.json(listDistricts(province));
  })
  .get("/areas/subdistricts", (c) => {
    const district = c.req.query("district") ?? "";
    if (areaLevel(district) !== "district") return bad(c, "district must be a 4-digit district code");
    c.header("Cache-Control", CACHE);
    return c.json(listSubDistricts(district));
  });
