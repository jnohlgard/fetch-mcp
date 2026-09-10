Work in the repo /projects/fetch-mcp on branch `fix/security-findings`.

You are one session in an ordered TDD remediation of the security audit in docs/security-findings.md. Findings before yours (#1, #2, #4, #8, #5, #7, #6, #10) are already done on this branch. This brief covers exactly one finding (stated below). Do not work on any other finding, do not restructure shared code, and do not open a PR.

Ground rules
- If node_modules is missing, run `bun install` first. bun.lock is gitignored, so a fresh checkout fails `bun test` without it.
- Before starting: `git status` must be clean and `bun test` must be all green. If either is not true, stop and report what you found. Do not fix other sessions' work.
- Strict TDD: (1) write the failing tests specified below, (2) run `bun test` and confirm the new tests fail for the right reason while every existing test still passes, (3) implement the minimal fix, (4) confirm the new tests pass, (5) run the full `bun test` until everything is green, (6) make one commit.
- Commit format: conventional style (`fix: ...`), subject under 72 chars, a short body explaining why, and the trailer line `Assisted-by: Crush:qwen3.8-27b`. Use a quoted heredoc like the existing commits (check `git log` for the exact pattern). Exactly one commit for this item. Never push, never merge, never amend history.
- Never add dependencies, never reformat, never touch files outside this item's scope.
- Code style: no em dashes and no semicolons in code, comments, or user-facing text. Older docs already contain a few. Do not add new ones.
- Environment: no internet and no external DNS. yt-dlp is NOT installed. Any test that triggers the availability probe must stub `child_process` so no real `which`/`where` ever runs.
- Test conventions: bun:test with the jest-compat API (`jest.fn`, `spyOn`). The code imports child_process dynamically with `await import("child_process")`. A `spyOn` on that namespace should intercept calls. If it does not, assign the property directly on the namespace object (precedent: src/cli.test.ts) and restore it in `afterAll`.
- Line numbers in this brief are hints from when the audit was written. Locate code by symbol name first.

---

## Task: Finding #11: yt-dlp availability is cached for the process lifetime (Low)

Context
`Fetcher.hasYtDlp` (src/Fetcher.ts) is set once by `checkYtDlp()` (which runs a shell probe) and never rechecked. The MCP server is long-lived: if the first check runs before yt-dlp is installed (or the PATH changes later), the wrong answer is frozen for the lifetime of the process.

Failing tests to write first (src/Fetcher.test.ts)

1. "rechecks once the cached answer is stale". In the test: reset `Fetcher.hasYtDlp = null` and `Fetcher.hasYtDlpAt = 0`, set the new `Fetcher.checkTtlMs = 0` (treat 0 as always stale), and stub `child_process.execSync` to FAIL on the first call and SUCCEED on the second (stubbing technique in the ground rules. Restore in `afterAll`). Call `await Fetcher.checkYtDlp()` twice. Assert the first call returns `false` and the second returns `true`. Today both return `false` because the first result is cached forever. That is the failing part.
2. "does not re-spawn while the cache is fresh". Set `Fetcher.hasYtDlp = true`, stamp `Fetcher.hasYtDlpAt = Date.now()`, set `Fetcher.checkTtlMs = 60000`, and stub `execSync` to count calls. `checkYtDlp()` must return `true` with zero `execSync` invocations.

IMPORTANT for this item: every existing test file whose `beforeEach` assigns `Fetcher.hasYtDlp` (at minimum src/Fetcher.test.ts. Also check src/Fetcher.fixture.test.ts and src/YouTubeTranscript.fixture.test.ts) must ALSO stamp `Fetcher.hasYtDlpAt = Date.now()` in that `beforeEach`. Otherwise the fresh-cache check looks stale and tests will start spawning the real probe binary.

Fix
Add `static hasYtDlpAt = 0` and `static checkTtlMs = 60000` to `Fetcher`. In `checkYtDlp`: if `hasYtDlp !== null` and `Date.now() - hasYtDlpAt < checkTtlMs`, return the cached value. Otherwise run the probe (keep the existing platform-aware `which`/`where` logic if the portability item already landed on this branch, else `which`) and store both the boolean and `hasYtDlpAt = Date.now()`.

Commit
`fix: expire the cached yt-dlp availability check`
Body: availability was probed once and frozen for the lifetime of the process, so a long-lived MCP server never noticed an install or removal. The cache now expires after a TTL (default 60 seconds, configurable via `Fetcher.checkTtlMs`).

When done, stop and report: the commit hash, the tests you added, the last lines of `bun test`, and any deviation from this brief.
