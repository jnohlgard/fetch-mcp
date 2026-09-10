Work in the repo /projects/fetch-mcp on branch `fix/security-findings`.

You are one session in an ordered TDD remediation of the security audit in docs/security-findings.md. Finding #1 (mapped-IPv6 SSRF) is already done on this branch. Findings land in the order 2, 4, 8, 5, 7, 6, 10, 11, 9, 3. This brief covers exactly one of them (stated below). Do not work on any other finding, do not restructure shared code, and do not open a PR.

Ground rules
- If node_modules is missing, run `bun install` first. bun.lock is gitignored, so a fresh checkout fails `bun test` without it.
- Before starting: `git status` must be clean and `bun test` must be all green. If either is not true, stop and report what you found. Do not fix other sessions' work.
- Strict TDD: (1) write the failing tests specified below, (2) run `bun test` and confirm the new tests fail for the right reason while every existing test still passes, (3) implement the minimal fix, (4) confirm the new tests pass, (5) run the full `bun test` until everything is green, (6) make one commit.
- Commit format: conventional style (`fix: ...`), subject under 72 chars, a short body explaining why, and the trailer line `Assisted-by: Crush:qwen3.8-27b`. Use a quoted heredoc like the existing commits (check `git log` for the exact pattern). Exactly one commit for this item. Never push, never merge, never amend history.
- Never add dependencies, never reformat, never touch files outside this item's scope.
- Code style: no em dashes and no semicolons in code, comments, or user-facing text. Older docs already contain a few. Do not add new ones.
- Environment: no internet and no external DNS. Loopback networking works. yt-dlp is NOT installed. Any test that touches the yt-dlp path must stub `child_process` and must never invoke the real binary.
- Test conventions: bun:test with the jest-compat API (`jest.fn`, `spyOn`). Mock fetch responses are plain objects like `{ ok: true, text: jest.fn().mockResolvedValueOnce("...") }` with no `body` property. Tests that monkeypatch `globalThis.fetch`, `dns.promises.lookup`, members of `child_process`, or `process.stderr.write` must restore the originals in `afterAll`. Existing error-string contracts (e.g. `disallowed protocol "file:"`, `private address`, `Invalid language code`) must stay intact.
- Line numbers in this brief are hints from when the audit was written. Locate code by symbol name first.

---

## Task: Finding #2: the YouTube transcript path bypasses all URL validation (Critical)

Context
`Fetcher.youtubeTranscript` (src/Fetcher.ts) calls `fetchTranscriptViaYtDlp` whenever yt-dlp is present, which runs `execFileSync("yt-dlp", [..., videoUrl])` with no URL validation of any kind. The zod schema `YouTubeTranscriptPayloadSchema` in src/types.ts declares `url: z.string().url()`, which accepts `file://`, `ftp://`, and `rtmp://` (verified on this machine). With yt-dlp installed, the `fetch_youtube_transcript` tool can therefore read local files (e.g. `file:///etc/passwd`) and return their contents. The direct fallback path already validates through `_fetch`. The yt-dlp path does not.

Failing tests to write first
Add a new describe block in src/Fetcher.test.ts next to the existing `youtubeTranscript` describe.

1. "never spawns yt-dlp for non-http(s) URLs". For each URL `file:///etc/passwd`, `ftp://example.com/file`, and `rtmp://example.com/live`:
   - In the test, set `Fetcher.hasYtDlp = true` (the file's `beforeEach` sets it to false).
   - Stub `child_process.execFileSync` so you can count invocations. The code imports child_process dynamically with `await import("child_process")`, so a `spyOn` on that namespace should intercept the call. If it does not, assign the property directly on the namespace object (precedent: src/cli.test.ts monkeypatches `process.exit` and the stdio writers the same way). Restore whatever you patched in `afterAll`.
   - Call `Fetcher.youtubeTranscript({ url })` and assert: `isError === true`, the message contains `disallowed protocol`, and `execFileSync` was never called.
2. "zod schema rejects non-http(s) URLs". Import `YouTubeTranscriptPayloadSchema` from src/types and assert `safeParse` fails for the three URLs above and still passes `https://www.youtube.com/watch?v=abc123`.
3. Regression: the existing happy-path `youtubeTranscript` tests (hasYtDlp false, mock fetch returning a player-response page) must stay green unchanged.

Fix
1. At the very top of `youtubeTranscript`, before `checkYtDlp` and any other use of the URL, call `this.validateUrl(requestPayload.url)`. Its `disallowed protocol` and `private address` errors are turned into `isError` results by the existing try/catch.
2. In src/types.ts, refine `YouTubeTranscriptPayloadSchema.url` to accept only http/https (keep `.url()` and add a protocol refinement like `refine((u) => /^https?:\/\//i.test(u))`). Leave `RequestPayloadSchema` alone. Those URLs already go through `validateUrl`.
3. While in `fetchTranscriptViaYtDlp`: cap the read `.srv1` file at `maxResponseBytes` (already imported in the file) and throw when the file is larger.

Commit
`fix: validate YouTube transcript URLs before yt-dlp or fetch use`
Body: the yt-dlp path never went through validateUrl, so file://, ftp://, and rtmp:// URLs reached execFileSync and could read local files. The URL is now validated at entry, the zod schema is restricted to http/https, and the subtitle file read is size-capped.

When done, stop and report: the commit hash, the tests you added, the last lines of `bun test`, and any deviation from this brief.
