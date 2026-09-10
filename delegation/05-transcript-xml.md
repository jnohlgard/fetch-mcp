Work in the repo /projects/fetch-mcp on branch `fix/security-findings`.

You are one session in an ordered TDD remediation of the security audit in docs/security-findings.md. Findings before yours (#1, #2, #4, #8, #5) are already done on this branch. This brief covers exactly one finding (stated below). Do not work on any other finding, do not restructure shared code, and do not open a PR.

Ground rules
- If node_modules is missing, run `bun install` first. bun.lock is gitignored, so a fresh checkout fails `bun test` without it.
- Before starting: `git status` must be clean and `bun test` must be all green. If either is not true, stop and report what you found. Do not fix other sessions' work.
- Strict TDD: (1) write the failing tests specified below, (2) run `bun test` and confirm the new tests fail for the right reason while every existing test still passes, (3) implement the minimal fix, (4) confirm the new tests pass, (5) run the full `bun test` until everything is green, (6) make one commit.
- Commit format: conventional style (`fix: ...`), subject under 72 chars, a short body explaining why, and the trailer line `Assisted-by: Crush:qwen3.8-27b`. Use a quoted heredoc like the existing commits (check `git log` for the exact pattern). Exactly one commit for this item. Never push, never merge, never amend history.
- Never add dependencies, never reformat, never touch files outside this item's scope.
- Code style: no em dashes and no semicolons in code, comments, or user-facing text. Older docs already contain a few. Do not add new ones.
- Environment: no internet and no external DNS. Loopback networking works. yt-dlp is NOT installed, so transcript-level tests run the direct path (`Fetcher.hasYtDlp = false`, which the test files' `beforeEach` already sets).
- Test conventions: bun:test with the jest-compat API (`jest.fn`, `spyOn`). Mock fetch responses are plain objects like `{ ok: true, text: jest.fn().mockResolvedValueOnce("...") }` with no `body` property. Sequential requests go through chained `.mockResolvedValueOnce` on the shared `mockFetch`. Restore anything you monkeypatch in `afterAll`.
- Line numbers in this brief are hints from when the audit was written. Locate code by symbol name first.

---

## Task: Finding #7: parseTranscriptXml is order-fragile, entity-incomplete, and reports empty transcripts as success (Medium)

Context
In src/YouTubeTranscript.ts:
- `parseTranscriptXml` uses `<text\s+start="([^"]+)"[^>]*>` and `<p\s+t="(\d+)"[^>]*>`. Both REQUIRE the first attribute to be `start` or `t`. Verified: `<p d="250" t="1234">hello</p>` (attributes in the other order) matches neither format and is silently dropped.
- The function returns `[]` for unparseable input, and `Fetcher.youtubeTranscript` turns that into a SUCCESS result with an empty transcript. That is silent data loss.
- `decodeHtmlEntities` handles only `&amp;`, `&lt;`, `&gt;`, `&quot;`, and `&#39;`. Real srv1 captions also use `&apos;`, `&nbsp;`, and decimal and hex numeric references.

Failing tests to write first

In src/YouTubeTranscript.test.ts (pure functions, no mocking needed):
1. "parses `<p>` tags with shuffled attribute order". Input: `<transcript><p d="250" t="1234">hello</p></transcript>`. Expect exactly one line: `[0:01] hello` (`t` is milliseconds).
2. "parses `<text>` tags when `start` is not the first attribute". For example `<text lang="en" start="1" dur="2">x</text>` must parse to the expected `[0:01] x` line.
3. "decodes the remaining entities". `&apos;` to `'`, `&nbsp;` to a plain space, `&#233;` to `é`, and `&#xE9;` to `é`. The existing five decodes must not change.
4. Keep all existing `parseTranscriptXml` tests green. Well-formed first-attribute input must keep producing byte-identical output.

In src/Fetcher.test.ts (youtubeTranscript level):
5. "returns an error when no captions parse". Two-mock pattern: player page, then a caption body of `<transcript></transcript>` (or any XML with no recognizable lines). Assert `isError === true` and a message that says no transcript captions were found (word it clearly). Today this returns success with an empty body, which is the failing part.

Fix
1. Make both formats attribute-order independent: match `/<p\b([^>]*)>([\s\S]*?)<\/p>/g` and `/<text\b([^>]*)>([\s\S]*?)<\/text>/g`, capture the whole attribute string, and extract `t=` (respectively `start=`) from it with small targeted regexes. Keep the format-1-first selection logic, the inline-tag stripping, and the `[m:ss] content` output format byte-identical for well-formed input. The existing tests and src/YouTubeTranscript.fixture.test.ts must stay green.
2. Extend `decodeHtmlEntities` with `&apos;` to `'`, `&nbsp;` to a plain space, and `&#(\d+);` plus `&#x([0-9a-fA-F]+);` via `String.fromCodePoint`. Keep the existing named-entity replacements and their order (`&amp;` first).
3. In `Fetcher.youtubeTranscript`, after `parseTranscriptXml`, throw when the line list is empty (message along the lines of `No transcript captions were found for this video`) so the outer catch produces an `isError` result.

Commit
`fix: harden transcript XML parsing against attribute order and empty results`
Body: shuffled `t`/`d`/`start` attributes were silently dropped, the entity set was incomplete, and zero parsed captions produced a success result with an empty transcript. The parsers are now attribute-order independent, decoding is complete, and an empty transcript is an error.

When done, stop and report: the commit hash, the tests you added, the last lines of `bun test`, and any deviation from this brief.
