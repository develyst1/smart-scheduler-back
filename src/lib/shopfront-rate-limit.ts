// TASK-475 (REQ-108 guard 4) — the shop-front QR's rate limit on phone lookups. Pure: the clock is passed in.
//
// 🔑 It counts MISSES, not lookups. A busy front desk is real families whose phones MATCH — they cost nothing. A guesser
// walking through numbers generates misses. So the limit falls on the guesser, never on the five minutes before class
// (a limit that punishes the rush is a limit that gets turned off). A hard ceiling on ALL lookups sits behind it.
// Kept on the server by client IP, so a page refresh or a cleared cookie does not reset it.
//
// ⚠️ THE HONEST LIMITS, in the code's own words (Sober, TASK-475 §B1):
// · It is ONE PROCESS'S MEMORY. A restart or deploy resets every count — acceptable for a guard against guessing.
//   If this app ever runs as N processes (PM2 cluster mode), every limit silently becomes N× — then the store must move
//   to a table.
// · The IP is only trustworthy while NGINX IS THE ONLY WAY IN. The route reads the first `X-Forwarded-For` hop; if the
//   app port is ever directly reachable, that header is the caller's to write and this limit is decorative.

export const SHOPFRONT_WINDOW_MS = 10 * 60_000;
/** Lookups that matched nothing check-in-able, per IP per window, before the IP is refused. */
export const SHOPFRONT_MISS_LIMIT = 5;
/** Every lookup, whatever it returned, per IP per window. */
export const SHOPFRONT_TOTAL_LIMIT = 60;
/** Bound on distinct IPs held; past it, IPs with nothing inside the window are dropped first. */
const MAX_TRACKED = 5000;

type Counts = { misses: number[]; all: number[] };

export class ShopfrontRateLimit {
  private byIp = new Map<string, Counts>();

  private counts(ip: string, now: number): Counts {
    const since = now - SHOPFRONT_WINDOW_MS;
    let c = this.byIp.get(ip);
    if (!c) {
      if (this.byIp.size >= MAX_TRACKED) this.sweep(now);
      c = { misses: [], all: [] };
      this.byIp.set(ip, c);
    }
    c.misses = c.misses.filter((t) => t > since);
    c.all = c.all.filter((t) => t > since);
    return c;
  }

  private sweep(now: number): void {
    const since = now - SHOPFRONT_WINDOW_MS;
    for (const [ip, c] of this.byIp) if (!c.misses.some((t) => t > since) && !c.all.some((t) => t > since)) this.byIp.delete(ip);
  }

  /** True when this IP may not look up (or check in) right now. Asked BEFORE the work, so a refused call costs no query. */
  blocked(ip: string, now: number): boolean {
    const c = this.counts(ip, now);
    return c.misses.length >= SHOPFRONT_MISS_LIMIT || c.all.length >= SHOPFRONT_TOTAL_LIMIT;
  }

  /** Record one lookup; `miss` = it found nothing check-in-able (or the act was refused as not in the list). */
  record(ip: string, now: number, miss: boolean): void {
    const c = this.counts(ip, now);
    c.all.push(now);
    if (miss) c.misses.push(now);
  }
}

/** The one limiter the routes use (module state — see the honest limits above). */
export const shopfrontRateLimit = new ShopfrontRateLimit();

/** The client IP as nginx hands it over: the FIRST `X-Forwarded-For` hop, else `cf-connecting-ip` (as `routes/webhooks.ts`). */
export const clientIp = (forwardedFor: string | undefined | null, cfIp?: string | null): string =>
  (forwardedFor ?? "").split(",")[0]!.trim() || (cfIp ?? "").trim() || "unknown";
