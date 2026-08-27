// A tiny helper for the tests that assert against SOURCE TEXT (the guards that no type can express: "this
// check runs before that call", "this mapper reads the column").
//
// 🔴 It exists because those tests silently broke on 2026-08-28: a `git checkout` on Windows rewrote the file
// with CRLF endings, every `indexOf("\n}\n")` returned -1, and six assertions failed with "Received: e" —
// nothing to do with the code they were guarding. A source-text test that depends on the checkout's line
// endings is a test that will cry wolf on somebody else's machine, and a guard nobody trusts gets deleted.
export const readSrc = (text: string): string => text.replace(/\r\n/g, "\n");
