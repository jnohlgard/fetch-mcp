Work in the repo /projects/fetch-mcp on branch `fix/security-findings`.

You are one session in an ordered TDD remediation of the security audit in docs/security-findings.md. Findings before yours (#1, #2, #4, #8, #5, #7) are already done on this branch. This brief covers exactly one finding (stated below). Do not work on any other finding, do not restructure shared code, and do not open a PR.

Ground rules
- If node_modules is missing, run `bun install` first. bun.lock is gitignored, so a fresh checkout fails `bun test` without it.
- Before starting: `git status` must be clean and `bun test` must be all green. If either is not true, stop and report what you found. Do not fix other sessions' work.
- Strict TDD: (1) write the failing tests specified below, (2) run `bun test` and confirm the new tests fail for the right reason while every existing test still passes, (3) implement the minimal fix, (4) confirm the new tests pass, (5) run the full `bun test` until everything is green, (6) make one commit.
- Commit format: conventional style (`fix: ...`), subject under 72 chars, a short body explaining why, and the trailer line `Assisted-by: Crush:qwen3.8-27b`. Use a quoted heredoc like the existing commits (check `git log` for the exact pattern). Exactly one commit for this item. Never push, never merge, never amend history.
- Never add dependencies, never reformat, never touch files outside this item's scope.
- Code style: no em dashes and no semicolons in code, comments, or user-facing text. Older docs already contain a few. Do not add new ones.
- Environment: no internet and no external DNS. All tests for this finding are pure-function tests and need no network.
- Line numbers in this brief are hints from when the audit was written. Locate code by symbol name first.

---

## Task: Finding #6: extractPlayerResponse truncates at the first `};` (Medium)

Context
`YouTubeTranscript.extractPlayerResponse` (src/YouTubeTranscript.ts) uses `/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s`, a lazy match up to the FIRST `};`. Any string value inside the JSON that contains `};` (description and snippet fields, embedded code snippets) truncates the object, `JSON.parse` throws, and transcript extraction fails on pages that should work. YouTube format drift makes this more likely over time.

Failing test to write first (src/YouTubeTranscript.test.ts, pure function)

1. "extracts a player response whose string values contain `};`". Build an HTML string like:

    var ytInitialPlayerResponse = {"x": "a; } and } more", "captions": {"c": 1}};

(that is, the JSON object contains a string value with `};` inside it, and the statement still ends with `};`). Assert `extractPlayerResponse` returns the object with the string value intact and `captions.c === 1`. Today the lazy regex cuts at the inner `};`, `JSON.parse` fails, and the test throws. That is the failing part.

2. Regression proof: the existing fixture test (src/YouTubeTranscript.fixture.test.ts, which uses a real captured player-response JSON) must stay green. It proves the new scanner finds the same object boundary on well-formed pages.

Fix
Replace the single regex with:
1. A regex to LOCATE the start: `/ytInitialPlayerResponse\s*=\s*\{/`.
2. From the position of that first `{`, a character walk tracking brace depth while skipping string literals: an in-string flag toggled by an unescaped `"`, and a backslash-escape flag so a `\"` does not toggle it. Stop when the depth returns to zero.
3. Slice from the first `{` through that closing brace (inclusive) and `JSON.parse` it.
Throw the existing `Could not find ytInitialPlayerResponse in page HTML` error when the marker is absent, and a clear error (e.g. `unbalanced braces in ytInitialPlayerResponse`) if the walk never reaches depth zero.

Commit
`fix: extract the player response with a balanced-brace scan`
Body: the lazy `};` regex truncated any player response whose string values contained `};`, breaking transcript extraction on valid pages. A character walk that tracks string escapes now finds the true object boundary.

When done, stop and report: the commit hash, the tests you added, the last lines of `bun test`, and any deviation from this brief.
