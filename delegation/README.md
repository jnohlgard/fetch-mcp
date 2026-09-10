# Delegation briefs for the fetch-mcp security remediation

One file per remaining finding on branch `fix/security-findings`. Each file is a complete initial user message for a fresh agent session: paste the file contents as the first prompt, in a session whose working directory is /projects/fetch-mcp.

Run the sessions in numeric order, one at a time, on the same branch. They share files (`src/Fetcher.ts`, `src/Fetcher.test.ts`, `src/types.ts`) and must not run in parallel in one working tree. If you want parallelism, give each session its own worktree and merge the branches back in the same numeric order.

| File | Finding | Scope in one line |
|---|---|---|
| 01-youtube-url-validation.md | #2 (Critical) | validate YouTube transcript URLs before yt-dlp or fetch, plus a zod protocol restriction |
| 02-lang-regex.md | #4 (High) | reject leading-hyphen yt-dlp language codes at both validation sites |
| 03-caption-url.md | #8 (Medium) | build caption URLs with the URL API instead of string concatenation |
| 04-ytdlp-portability.md | #5 (High) | `mkdtempSync`, platform-aware probe, one stderr line on silent fallback |
| 05-transcript-xml.md | #7 (Medium) | attribute-order-independent parsing, complete entity decoding, error on zero captions |
| 06-player-response.md | #6 (Medium) | balanced-brace extraction of `ytInitialPlayerResponse` |
| 07-surrogate-slicing.md | #10 (Low) | surrogate-safe `applyLengthLimits` |
| 08-ytdlp-ttl.md | #11 (Low) | TTL on the `hasYtDlp` cache (and stamp `hasYtDlpAt` in every `beforeEach` that sets it) |
| 09-json-fidelity.md | #9 (Low) | `json()` returns the original body, `JSON.parse` stays as validator |
| 10-per-hop-redirects.md | #3 (Critical, last) | manual redirect following with per-hop validation, restore the docs claims |
| 11-final-sweep.md | closeout | finding #12 JSDOM guard test, mark all findings resolved, doc sync, PR-ready summary |

Prerequisite state for file 01: branch `fix/security-findings` at or after commit `5c5c010` (finding #1 done), clean tree, `bun test` all green.

Each brief embeds the shared ground rules (strict TDD, commit format with the `Assisted-by: Crush:qwen3.8-27b` trailer, stubbing rules, test conventions). A session needs nothing else from you.
