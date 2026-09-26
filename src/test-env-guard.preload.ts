// TASK-503 — runs before EVERY test file (`bunfig.toml` → `[test] preload`), including `bun test <one file>`: refuses the whole run
// when `.env` points at the customer's system (uat / the real OA). It reads only; it changes nothing, and it imports no app code —
// so nothing can connect before it decides. `sid` and local runs pass straight through, silently. The rules: `lib/test-env-guard.ts`.
import { customerEnvSignals, refusalMessage } from "./lib/test-env-guard";

const signals = customerEnvSignals(process.env);
if (signals.length) throw new Error(refusalMessage(signals));
