Work in the repo /projects/fetch-mcp on branch `fix/security-findings`.

You are one session in an ordered TDD remediation of the security audit in docs/security-findings.md. Findings before yours (#1, #2, #4) are already done on this branch. This brief covers exactly one finding (stated below). Do not work on any other finding, do not restructure shared code, and do not open a PR.

Ground rules
- If node_modules is missing, run `bun install` first. bun.lock is gitignored, so a fresh checkout fails `bun test` without it.
- Before starting: `git status` must be clean and `bun test` must be all green. If either is not true, stop and report what you found. Do not fix other sessions' work.
- Strict TDD: (1) write the failing tests specified below, (2) run `bun test` and confirm the new tests fail for the right reason while every existing test still passes, (3) implement the minimal fix, (4) confirm the new tests pass, (5) run the full `bun test` until everything is green, (6) make one commit.
- Commit format: conventional style (`fix: ...`), subject under 72 chars, a short body explaining why, and the trailer line `Assisted-by: Crush:qwen3.8-27b`. Use a quoted heredoc like the existing commits (check `git log` for the exact pattern). Exactly one commit for this item. Never push, never merge, never amend history.
- Never add dependencies, never reformat, never touch files outside this item's scope.
- Code style: no em dashes and no semicolons in code, comments, or user-facing text. Older docs already contain a few. Do not add new ones.
- Environment: no internet and no external DNS. Loopback networking works. yt-dlp is NOT installed, so all transcript tests run the direct path (`Fetcher.hasYtDlp = false`, which the test file's `beforeEach` already sets).
- Test conventions: bun:test with the jest-compat API (`jest.fn`, `spyOn`). Mock fetch responses are plain objects like `{ ok: true, text: jest.fn().mockResolvedValueOnce("...") }` with no `body` property. Sequential requests go through chained `.mockResolvedValueOnce` on the shared `mockFetch`. Restore anything you monkeypatch in `afterAll`.
- Line numbers in this brief are hints from when the audit was written. Locate code by symbol name first.

---

## Task: Finding #8: caption URL built by string concatenation (Medium)

Context
In `fetchTranscriptDirect` (src/Fetcher.ts), the caption URL is built as:

    track.baseUrl + (track.baseUrl.includes("fmt=") ? "" : "&fmt=srv1")

Two bugs:
1. If `baseUrl` has no query string at all, the result uses `&fmt=srv1` with no leading `?`, producing a malformed query the server will reject or misparse.
2. `includes("fmt=")` is a substring check over the whole URL. A `baseUrl` containing `fmt=` inside any other parameter (e.g. `?filter=fmt=x`) suppresses the append, so the requested `fmt=srv1` is never sent.

Failing tests to write first
In src/Fetcher.test.ts, add tests in the `youtubeTranscript` area using the established two-mock pattern:
- First mock fetch: a page whose HTML embeds `ytInitialPlayerResponse = { ... };` with `captions.playerCaptionsTracklistRenderer.captionTracks` containing one track (`baseUrl`, `languageCode: "en"`, `name: { simpleText: "English" }`). Copy the shape from the existing youtubeTranscript tests in the file.
- Second mock fetch: the caption request, returning minimal srv1 XML with one line, e.g. `<transcript><p t="1234" d="250">hello</p></transcript>`.

1. "appends ?fmt=srv1 when the base URL has no query string". Use a `baseUrl` with no `?`. Assert on the SECOND call to `mockFetch` (inspect `mockFetch.mock.calls[1][0]`): the URL parses with `new URL(...)`, its `searchParams.get("fmt")` is `"srv1"`, and the raw string contains exactly one `?`. Today the built string contains no `?` at all, so this fails for the right reason.
2. "does not get confused by a fmt= substring elsewhere". Use a `baseUrl` like `https://example.com/api/timedtext?lang=en&filter=fmt=x`. Assert `new URL(secondCallUrl).searchParams.get("fmt") === "srv1"`. Today the append is suppressed, so this fails.

Also keep the existing transcript fixture test (src/YouTubeTranscript.fixture.test.ts) green. It uses real player-response JSON whose `baseUrl` already carries a query string, and the fix must keep that working.

Fix
Replace the concatenation with:

    const captionUrl = new URL(track.baseUrl)
    captionUrl.searchParams.set("fmt", "srv1")

and pass `captionUrl.toString()` to `_fetch`.

Commit
`fix: build caption URLs with the URL API instead of string concatenation`
Body: the manual concatenation produced `&fmt=srv1` without a leading `?` on query-less base URLs, and a `fmt=` substring in any other parameter suppressed the append entirely. `searchParams.set` handles both cases and produces a correctly encoded query.

When done, stop and report: the commit hash, the tests you added, the last lines of `bun test`, and any deviation from this brief.
