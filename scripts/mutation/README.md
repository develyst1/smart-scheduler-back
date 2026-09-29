# Mutation runner — break the code on purpose, see whether the tests notice

A **mutation** is a deliberate, small break in the source (a line removed, a condition inverted). A test suite that stays green
when the code is broken proves nothing. This directory breaks the code, runs the tests, **restores every file byte-for-byte**,
and reports a **verdict** for each mutation.

It lives in the repo on purpose (TASK-576): **a tool that proves our tests are honest, kept in a session scratchpad, is a tool
we silently stop having — and its absence looks exactly like nobody having run it.**

---

## THE VERDICT RULE

> **This section is the rule, not documentation of the code. It is written to be copied VERBATIM into any other repo's
> mutation runner. What must be identical across repos is this rule — not a shared file.**

1. **A verdict comes ONLY from the test run's parsed FINAL summary counts** — the number of tests that passed and the number that
   failed, as the test runner prints them at the very end. Never from failure names, never from the exit code, never from
   the absence of an error, never from a signal.
2. **There are exactly three verdicts:**
   - **BITES** — the summary says at least one test failed, or fewer tests passed than the unmutated baseline. The tests
     noticed the break.
   - **SURVIVED** — the summary says no test failed and at least the baseline passed. The tests did NOT notice the break.
   - **NO RESULT** — there is no summary to read: the output overflowed its capture, the run was killed, it timed out, or it
     crashed before summarising. It always carries its **reason**.
3. **NO RESULT is never a colour.** It is not a pass and it is not a bite. **A timeout is not a bite. An absent summary is not
   a pass.**
4. **The baseline is measured, on the same test set, with no mutation applied — and it must itself be a clean result**
   (a summary, zero failures). A dirty or absent baseline means no mutation is run at all.
5. **The capture must not be the limit.** Output is captured with a buffer far larger than any real run (here 512 MiB); a
   run's size is reported beside its verdict, so one approaching the limit is visible before it becomes a NO RESULT.

### What NO RESULT obliges the reader to do

**Nothing about that mutation is known.** You must NOT report it as caught, and you must NOT report it as survived. You must:

- **fix the reason and run it again** — a bigger capture for OUTPUT OVERFLOW, a longer limit or a fix for a hang for KILLED,
  the crash for ERROR — **until it yields counts**; or
- **report it as NO RESULT, with the reason**, and treat that break as **unproven**.

**"It is probably fine" is not an option.** Both ways of getting this wrong have happened here (TASK-575): one runner read a
lost summary as GREEN (a failing run called a pass); another read the kill signal of an overflow as "hung" and so as a BITE —
**proven to call a run where every test passed "caught"**. Both were false reassurance.

---

## Use

```bash
bun run mutation:run -- --tests "src/lib/a.test.ts src/services/b.test.ts" --mutations path/to/mutations.json
```

`mutations.json` — a list; each mutation may edit several files, each edit's `from` must match **exactly once** (else the row
says `ANCHOR MISSING` / `ANCHOR AMBIGUOUS` and nothing is run):

```json
[
  { "id": "M1", "what": "the guard removed", "files": [
    { "file": "src/lib/x.ts", "edits": [ { "from": "if (a) throw oops();", "to": "" } ] } ] }
]
```

Every run: the database is **unreachable** and the LINE token **blank** (a mutation must not be able to touch anything real);
each mutation's files are restored and checked; the whole working tree's checksum is compared before and after
(`CHECKSUM identical` — otherwise the run exits non-zero). `--baseline N` overrides the measured baseline.

```bash
bun run mutation:prove
```

Proves the rule on **real** runs (fixtures written to a temp directory, never into this suite): >1 MiB of output with one
failing test ⇒ BITES · >1 MiB with every test passing ⇒ SURVIVED · a forced overflow ⇒ NO RESULT [OUTPUT OVERFLOW] · a run
killed by the time limit ⇒ NO RESULT [KILLED] · no output ⇒ NO RESULT [NO SUMMARY]. Exits non-zero if any case is wrong.

## Files

| file | job |
|---|---|
| `verdict.ts` | **THE decision** (`classify`) and **THE way to run the tests** (`runAndClassify` — `bun` spawned directly, never through a shell: through a shell a time limit kills the shell and leaves the tests running as an orphan) |
| `run.ts` | the driver: apply · run · restore · report, with the tree checksum |
| `prove.ts` | the rule, proven on real runs |

## What was deliberately NOT moved here

- **The ~100 per-task runners** (`mut364` … `mut507`, one per task). They were one task's scaffolding each: a hard-coded
  test list and inline mutation list. The mutations themselves are recorded in each TASK's report, which is where they belong.
- **Their decision rules — on purpose.** Families of them read a missing summary as caught (`?` counts), read any `error:`
  or a SIGTERM as a bite, or read the first `N fail` in the output rather than the final summary. **Those are the defects
  this rule exists to end;** preserving them would preserve the defect.
- **Historical tables are not re-run** (ruled, TASK-575): the measured margin (≈1.3 KB per failure; a real run never came
  near the old 1 MiB) and no recorded row with a `?` count. An implausible historical count gets **that row** re-run with
  this tool — not every table on principle.
