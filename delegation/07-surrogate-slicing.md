Work in the repo /projects/fetch-mcp on branch `fix/security-findings`.

You are one session in an ordered TDD remediation of the security audit in docs/security-findings.md. Findings before yours (#1, #2, #4, #8, #5, #7, #6) are already done on this branch. This brief covers exactly one finding (stated below). Do not work on any other finding, do not restructure shared code, and do not open a PR.

Ground rules
- If node_modules is missing, run `bun install` first. bun.lock is gitignored, so a fresh checkout fails `bun test` without it.
- Before starting: `git status` must be clean and `bun test` must be all green. If either is not true, stop and report what you found. Do not fix other sessions' work.
- Strict TDD: (1) write the failing tests specified below, (2) run `bun test` and confirm the new tests fail for the right reason while every existing test still passes, (3) implement the minimal fix, (4) confirm the new tests pass, (5) run the full `bun test` until everything is green, (6) make one commit.
- Commit format: conventional style (`fix: ...`), subject under 72 chars, a short body explaining why, and the trailer line `Assisted-by: Crush:qwen3.8-27b`. Use a quoted heredoc like the existing commits (check `git log` for the exact pattern). Exactly one commit for this item. Never push, never merge, never amend history.
- Never add dependencies, never reformat, never touch files outside this item's scope.
- Code style: no em dashes and no semicolons in code, comments, or user-facing text. Older docs already contain a few. Do not add new ones.
- Environment: no internet and no external DNS. All tests for this finding use the mocked global fetch from the test file and need no network.
- Test conventions: bun:test with the jest-compat API (`jest.fn`, `spyOn`). Mock fetch responses are plain objects like `{ ok: true, text: jest.fn().mockResolvedValueOnce("...") }` with no `body` property. The file's `beforeEach` installs the mock fetch, a public-IP DNS stub, and `Fetcher.hasYtDlp = false`.
- Line numbers in this brief are hints from when the audit was written. Locate code by symbol name first.

---

## Task: Finding #10: applyLengthLimits splits surrogate pairs (Low, affects all content tools)

Context
`Fetcher.applyLengthLimits` (src/Fetcher.ts) uses `String.prototype.substring`, which counts UTF-16 code units. Any `max_length` or `start_index` boundary landing in the middle of a surrogate pair (for example an emoji) emits a lone surrogate into the output. Verified with `"abc🙂def"` sliced at the pair boundary: the result contains a bare `\ud83d`. Lone surrogates corrupt downstream text handling and can make JSON-RPC framing throw on some runtimes. This affects every content tool because they all funnel through `applyLengthLimits`.

Failing tests to write first (src/Fetcher.test.ts, a new describe such as `surrogate safety`)

Use `Fetcher.html` (raw pass-through, so the length limits apply directly to the fetched body). Mock fetch returns the body `abc🙂def` (three letters, one two-code-unit emoji, three letters. That is seven code units but six code points. In code-unit indices the emoji occupies positions 3 and 4).

1. "does not split an emoji when max_length ends mid-pair". Choose a `max_length` whose end index falls between the emoji's high and low surrogates (with the body as given, `max_length: 5` does that). Assert `isError === false` and that the output matches what you get by slicing the full content at the same USER-VISIBLE position, i.e. `Array.from(fullBody).slice(0, 5).join("")`. Equivalently (or additionally) assert that no character in the output has a code point in the surrogate range 0xD800 to 0xDFFF.
2. "does not split an emoji when start_index begins mid-pair". Choose a `start_index` pointing at the low surrogate position (index 4 in the body above) with a `max_length` that runs to the end. Same assertions: the output matches a code-point slice and contains no lone surrogate.

Both fail today (the output contains a bare high surrogate) and pass after the fix.

Fix
In `applyLengthLimits`, keep the fast `substring` path, but first check whether either boundary (the start index or the end index) lands inside a pair: the code unit at index `i` is in `0xDC00` to `0xDFFF` AND the code unit at `i - 1` is in `0xD800` to `0xDBFF`. Only in that case, do this call on code points via `Array.from(text)` (slice, then `join("")`). Keep the `startIndex >= text.length` guard and the `maxLength === 0` means-unlimited semantics unchanged.

Commit
`fix: keep length-limit slicing surrogate-safe`
Body: `substring` counts UTF-16 code units, so `max_length`/`start_index` boundaries could land inside a surrogate pair and emit a lone surrogate. The slow path now operates on code points, and only when a boundary actually lands mid-pair, so the common case stays on the fast path.

When done, stop and report: the commit hash, the tests you added, the last lines of `bun test`, and any deviation from this brief.
