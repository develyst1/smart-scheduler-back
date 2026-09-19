import { Hono } from "hono";
import { zValidator } from "../lib/validate";
import * as v from "../validation";
import * as camp from "../services/camp.service";
import { actorOf } from "../services/user.service";
import { assertMayDiscount } from "../lib/discount-plan";
import { campPriceList } from "../lib/sale-items";

// TASK-401 (REQ-095 Stage 3a, SPEC-082) — Balance camp. Mounted at `/api/camp` behind the guard; the access table maps
// every read to `menu:camp` and every write to its own act. The sale's discount (early bird) is gated like every other
// discount — `action:sales.discount` at the route, the fifth site.
export const campRoutes = new Hono()
  .get("/prices", (c) => c.json({ items: campPriceList() }))
  .get("/weeks", zValidator("query", v.campWeeksQuery), async (c) => c.json(await camp.listWeeks(c.req.valid("query"))))
  .post("/weeks", zValidator("json", v.createCampWeek), async (c) => c.json(await camp.createWeek(c.req.valid("json"), actorOf(c)), 201))
  .patch("/weeks/:id", zValidator("json", v.updateCampWeek), async (c) => c.json(await camp.updateWeek(c.req.param("id"), c.req.valid("json"))))
  .get("/weeks/:id/days", async (c) => c.json(await camp.weekDays(c.req.param("id"))))
  .get("/packages", zValidator("query", v.campPackagesQuery), async (c) => c.json(await camp.listPackages(c.req.valid("query").studentId)))
  .post("/packages", zValidator("json", v.createCampPackage), async (c) => {
    const body = c.req.valid("json");
    assertMayDiscount(body.discount, c.get("user"));
    return c.json(await camp.createPackage({ ...body, actor: actorOf(c) }), 201);
  })
  .post("/packages/:id/days", zValidator("json", v.redeemCampDays), async (c) => c.json(await camp.redeemDays(c.req.param("id"), c.req.valid("json"), actorOf(c)), 201))
  // TASK-403: `status: "PLANNED"` + `reason` is the UNDO (units back, no money); the same act key — a mark is a mark.
  .patch("/days/:id", zValidator("json", v.markCampDay), async (c) => {
    const body = c.req.valid("json");
    return c.json(await camp.markDay(c.req.param("id"), body.status, actorOf(c), body.reason ?? null));
  })
  // TASK-403: the day's check-in QR — the token is minted on the first view (lazy), lives to 23:59:59 of the date.
  .get("/days/:id/checkin", async (c) => c.json(await camp.getDayCheckinQr(c.req.param("id"))));
