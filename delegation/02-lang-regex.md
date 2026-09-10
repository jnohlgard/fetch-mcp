Work in the repo /projects/fetch-mcp on branch `fix/security-findings`.

You are one session in an ordered TDD remediation of the security audit in docs/security-findings.md. Findings before yours (#1 mapped-IPv6 SSRF, and #2 YouTube URL validation) are already done on this branch. This brief covers exactly one finding (stated below). Do not work on any other finding, do not restructure shared code, and do not open a PR.

Ground rules
- If node_modules is missing, run `bun install` first. bun.lock is gitignored, so a fresh checkout fails `bun test` without it.
- Before starting: `git status` must be clean and `bun test` must be all green. If either is not true, stop and report what you found. Do not fix other sessions' work.
- Strict TDD: (1) write the failing tests specified below, (2) run `bun test` and confirm the new tests fail for the right reason while every existing test still passes, (3) implement the minimal fix, (4) confirm the new tests pass, (5) run the full `bun test` until everything is green, (6) make one commit.
- Commit format: conventional style (`fix: ...`), subject under 72 chars, a short body explaining why, and the trailer line `Assisted-by: Crush:qwen3.8-27b`. Use a quoted heredoc like the existing commits (check `git log` for the exact pattern). Exactly one commit for this item. Never push, never merge, never amend history.
- Never add dependencies, never reformat, never touch files outside this item's scope.
- Code style: no em dashes and no semicolons in code, comments, or user-facing text. Older docs already contain a few. Do not add new ones.
- Environment: no internet and no external DNS. Loopback networking works. yt-dlp is NOT installed. Any test that touches the yt-dlp path must stub `child_process` and must never invoke the real binary.
- Test conventions: bun:test with the jest-compat API (`jest.fn`, `spyOn`). The code imports child_process dynamically with `await import("child_process")`. A `spyOn` on that namespace should intercept calls. If it does not, assign the property directly on the namespace object (precedent: src/cli.test.ts) and restore it in `afterAll`. Existing error-string contracts (e.g. `Invalid language code`) must stay intact.
- Line numbers in this brief are hints from when the audit was written. Locate code by symbol name first.

---

## Task: Finding #4: yt-dlp argument injection through the `lang` field (High)

Context
The language sanitizer regex `/^[a-zA-Z0-9-]+$/` appears twice in src/Fetcher.ts: in `fetchTranscriptViaYtDlp` and in `youtubeTranscript` (the check right before the yt-dlp call). It accepts leading hyphens, so `lang` values like `-o`, `--sub-format`, and `--skip-download` pass validation and land in the `execFileSync("yt-dlp", [...])` argument list as extra flags. That is option injection into a child process running with the server's full privileges. A stray `*.srv1` pattern in .gitignore is evidence this misbehaves in practice.

Failing tests to write first
Extend the existing `yt-dlp lang sanitization` describe in src/Fetcher.test.ts.

For each `lang` in `"-o"`, `"--sub-format"`, and `"--skip-download"`:
- Set `Fetcher.hasYtDlp = true`.
- Stub `child_process.execFileSync` to count invocations (stubbing approach in the ground rules above. Restore in `afterAll`).
- Call `Fetcher.youtubeTranscript({ url: "https://www.youtube.com/watch?v=abc123", lang })` and assert: `isError === true`, the message contains `Invalid language code`, and `execFileSync` was never called.

Must stay green: the existing tests asserting `en; rm -rf /` and `$(whoami)` are rejected with `Invalid language code`.

Add positive coverage: `lang` values `es-419` and `zh-Hans` must NOT produce `Invalid language code`. With `hasYtDlp = true` and a stubbed `execFileSync` that throws, the flow falls back to the direct path (which needs a mock fetch or will fail with a fetch-level error). Assert the resulting error message is not the language error, which proves validation let the value through.

Fix
Replace the regex at BOTH sites with `/^[a-zA-Z0-9][a-zA-Z0-9-]{0,9}$/`. It must start with a letter or digit, may contain hyphens, and is capped at 10 characters total, which covers real BCP-47 tags (`en`, `es-419`, `zh-Hans`). Update the error message wording if it describes the allowed set.

Commit
`fix: reject yt-dlp language codes with leading hyphens`
Body: leading-hyphen language values were injected into the yt-dlp argument list as flags (e.g. `-o`, `--skip-download`). The sanitizer regex was tightened at both validation sites. BCP-47 codes like es-419 and zh-Hans still pass.

When done, stop and report: the commit hash, the tests you added, the last lines of `bun test`, and any deviation from this brief.
