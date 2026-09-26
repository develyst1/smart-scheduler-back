// TASK-506 — a PROBE for `crash-policy-req108.test.ts` ONLY: preloaded into a REAL entry run (`bun --preload <this> src/index.ts`),
// it raises one unhandled rejection and then one uncaught throw, so the test can watch the server's crash policy act on a genuine
// boot. It is never loaded by the app, the suite, or any script.
setTimeout(() => {
  void Promise.reject(new Error("probe-rejection"));
}, 1500);
setTimeout(() => {
  throw new Error("probe-uncaught");
}, 3000);
