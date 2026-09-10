Work in the repo /projects/fetch-mcp on branch `fix/security-findings`.

You are one session in an ordered TDD remediation of the security audit in docs/security-findings.md. Findings before yours (#1, #2, #4, #8, #5, #7, #6, #10, #11) are already done on this branch. This brief covers exactly one finding (stated below). Do not work on any other finding, do not restructure shared code, and do not open a PR.

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

## Task: Finding #9: fetch_json re-serializes and mutates large numbers (Low)

Context
`Fetcher.json` (src/Fetcher.ts) does `JSON.parse` and then `JSON.stringify` on the body. JavaScript number semantics mutate the payload: verified `9007199254740993` comes back as `9007199254740992`, and `1e308` (which parses to Infinity) comes back as `null`. The tool's contract is to return the JSON response. It should validate that the body IS JSON, but hand back what the server actually sent.

Decision already made (record it in the commit body): keep `JSON.parse` purely as a validator, and return the original raw text.

Failing tests to write first (src/Fetcher.test.ts)

1. "returns the original digits for large numbers". Mock fetch (ok) returns the body `{"big": 9007199254740993}`. Call `Fetcher.json` with a plain URL request. Assert `isError === false` and that `content[0].text` contains `9007199254740993` exactly (as a substring). Today it comes back as `9007199254740992`. That is the failing part.
2. "still rejects invalid JSON". Mock fetch returns `<html>not json</html>`. Assert `isError === true` (behavior preserved. The parse validation stays).
3. Audit the existing `json` tests: if any asserted the re-stringified form of a payload whose digits or spacing change under the new behavior, update that expectation to the raw body and note the change in the commit body. Everything else must stay green.

Fix
In `Fetcher.json`: keep `JSON.parse(text)` purely as validation (it still throws on invalid input and flows into the existing error handling), but build the response from the ORIGINAL raw `text` instead of `JSON.stringify(json)`. Still run it through `applyLengthLimits`.

Commit
`fix: return the original body from fetch_json instead of a re-serialized copy`
Body: the parse-then-stringify round trip mutated data. Verified `9007199254740993` became `9007199254740992` and `1e308` became `null`. The parse stays as a JSON validator. The raw server response is now returned as-is (still length-limited), which matches the return-the-JSON-response contract.

When done, stop and report: the commit hash, the tests you added, the last lines of `bun test`, and any deviation from this brief.
