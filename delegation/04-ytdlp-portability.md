Work in the repo /projects/fetch-mcp on branch `fix/security-findings`.

You are one session in an ordered TDD remediation of the security audit in docs/security-findings.md. Findings before yours (#1, #2, #4, #8) are already done on this branch. This brief covers exactly one finding (stated below). Do not work on any other finding, do not restructure shared code, and do not open a PR.

Ground rules
- If node_modules is missing, run `bun install` first. bun.lock is gitignored, so a fresh checkout fails `bun test` without it.
- Before starting: `git status` must be clean and `bun test` must be all green. If either is not true, stop and report what you found. Do not fix other sessions' work.
- Strict TDD: (1) write the failing tests specified below, (2) run `bun test` and confirm the new tests fail for the right reason while every existing test still passes, (3) implement the minimal fix, (4) confirm the new tests pass, (5) run the full `bun test` until everything is green, (6) make one commit.
- Commit format: conventional style (`fix: ...`), subject under 72 chars, a short body explaining why, and the trailer line `Assisted-by: Crush:qwen3.8-27b`. Use a quoted heredoc like the existing commits (check `git log` for the exact pattern). Exactly one commit for this item. Never push, never merge, never amend history.
- Never add dependencies, never reformat, never touch files outside this item's scope.
- Code style: no em dashes and no semicolons in code, comments, or user-facing text. Older docs already contain a few. Do not add new ones.
- Environment: no internet and no external DNS. Loopback networking works. yt-dlp is NOT installed. Any test that touches the yt-dlp path must stub `child_process` and must never invoke the real binary.
- Test conventions: bun:test with the jest-compat API (`jest.fn`, `spyOn`). The code imports child_process dynamically with `await import("child_process")`. A `spyOn` on that namespace should intercept calls. If it does not, assign the property directly on the namespace object (precedent: src/cli.test.ts) and restore it in `afterAll`.
- Line numbers in this brief are hints from when the audit was written. Locate code by symbol name first.

---

## Task: Finding #5: the yt-dlp integration is Unix-only and falls back silently (High)

Context
In src/Fetcher.ts:
- `fetchTranscriptViaYtDlp` creates its temp dir with `execSync("mktemp -d")` (Unix-only).
- `checkYtDlp` probes with `execSync("which yt-dlp")` (Unix-only).
- `youtubeTranscript` swallows every yt-dlp failure in a bare `catch` and silently falls back to direct extraction, so an operator never learns yt-dlp is missing or broken.
On Windows both shell probes fail, and on every platform the failure is invisible.

Failing tests to write first (src/Fetcher.test.ts)

1. "prepares its temp dir without any Unix shell command". Set `Fetcher.hasYtDlp = true`. Stub `execFileSync` so the yt-dlp success path runs: the stub should find its own `-o` argument (the value right after `-o` in the args array, shaped like `<tmpdir>/sub`), take its parent directory, and write a file named `sub.en.srv1` there containing one `<p t="1234" d="250">hello</p>` line. Spy `execSync` with the same technique (restore both in `afterAll`). Call `Fetcher.youtubeTranscript({ url: "https://www.youtube.com/watch?v=abc123" })` and assert: `isError === false`, the transcript contains the caption line, and `execSync` was never called. Today it is called with `mktemp -d`, so the call-count assertion is the failing part.
2. "reports on stderr when yt-dlp fails and it falls back to direct extraction". Set `Fetcher.hasYtDlp = true`. Stub `execFileSync` to throw. Monkeypatch `process.stderr.write` to capture output (precedent: src/cli.test.ts) and restore it in `afterAll`. Mock `globalThis.fetch` with the two-mock pattern (player page then caption body) so the direct fallback succeeds. Assert exactly one line was written to stderr, that it mentions `yt-dlp`, and that it says the request fell back to direct extraction. Today nothing is written, which is the failing part.

Fix
1. Replace `execSync("mktemp -d")` with `fs.mkdtempSync(path.join(os.tmpdir(), "fetch-mcp-"))` (import `fs`, `os`, and `path`. Keep the existing `rmSync` cleanup in the `finally`).
2. In `checkYtDlp`, probe with `which yt-dlp` on POSIX and `where yt-dlp` when `process.platform === "win32"`.
3. In the yt-dlp fallback `catch` inside `youtubeTranscript`, write ONE line to `process.stderr` of the form: `yt-dlp failed (<short reason>). Falling back to direct transcript extraction.` Stderr is the correct channel in both deployment contexts: MCP speaks JSON-RPC on stdout, and the CLI already uses stderr for errors. stdout must stay untouched in all cases.

Commit
`fix: make the yt-dlp integration portable and report fallbacks on stderr`
Body: `mktemp -d` and `which` are Unix-only, and the bare catch hid every failure from operators. The temp dir now comes from `os.tmpdir()`, the availability probe is platform-aware, and each fallback writes one diagnostic line to stderr.

When done, stop and report: the commit hash, the tests you added, the last lines of `bun test`, and any deviation from this brief.
