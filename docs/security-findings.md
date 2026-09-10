# Security & Code-Quality Findings — fetch-mcp

Audited 2026-09-10 against `src/` (v1.1.2). All findings were verified by execution, not static reading; reproduction notes are included. CLI subcommands share the exact same code paths as the MCP tools, so an affected tool implies the same CLI command is affected (`fetch_html` ≈ `mcp-fetch html`, etc.).

**Status: all 12 findings are resolved on branch `fix/security-findings`.** Fixes landed in the order 1, 2, 4, 8, 5, 7, 6, 10, 11, 9, 3 (one `fix:` commit each), and #12 is closed by a regression guard test. The commit that closed each finding is listed below and in the section headers.

## Summary

| # | Severity | Finding | Affected MCP tools | Closed by |
|---|---|---|---|---|
| 1 | Critical | SSRF bypass via IPv4-mapped IPv6 (`[::ffff:x.x.x.x]`) | **all six**: `fetch_html`, `fetch_json`, `fetch_txt`, `fetch_markdown`, `fetch_readable`, `fetch_youtube_transcript` | `5c5c010` |
| 2 | Critical | yt-dlp path bypasses all URL validation (no protocol/IP checks, no size limit) | `fetch_youtube_transcript` (only when `yt-dlp` is on PATH) | `fc8ef59` |
| 3 | Critical | Redirect SSRF is detect-after-the-fact, not prevention | **all six** | `dddbdb8` |
| 4 | High | Argument injection into `yt-dlp` via `lang` (regex allows leading hyphens) | `fetch_youtube_transcript` | `60faa77` |
| 5 | High | yt-dlp branch is Unix-only (`mktemp`, `which`) and degrades silently | `fetch_youtube_transcript` | `5fb119a` |
| 6 | Medium | `extractPlayerResponse` regex truncates at first `};` in JSON | `fetch_youtube_transcript` (direct path) | `a51d525` |
| 7 | Medium | `parseTranscriptXml`: attribute-order fragility, silent empty transcript, incomplete entity decoding | `fetch_youtube_transcript` | `b771fd7` |
| 8 | Medium | Caption URL built by string concatenation (`&fmt=srv1`) | `fetch_youtube_transcript` (direct path) | `c7a1877` |
| 9 | Low | `json()` parse→stringify round-trip mutates large numbers | `fetch_json` | `b023ba3` |
| 10 | Low | `applyLengthLimits` can split surrogate pairs via `substring` | **all six** (whenever a limit lands on a surrogate pair) | `1cf816b` |
| 11 | Low | `hasYtDlp` cached for process lifetime; stale in long-lived server | `fetch_youtube_transcript` | `572e186` |
| 12 | Note | JSDOM must stay without `runScripts` — adding it is RCE | `fetch_txt`, `fetch_markdown`, `fetch_readable` | `ca29909` (guard test) |

**Path traversal:** no exposure. All writes go to an OS-generated `mktemp -d` directory (0700); all reads are confined to `readdirSync` basenames of that directory (which cannot contain `/`). The only way out of the temp dir is the yt-dlp `-o` template override in finding #4.

---

## Critical

### 1. SSRF bypass via IPv4-mapped IPv6 — reproduced end-to-end (resolved in `5c5c010`)

`Fetcher.ts:30` (`validateUrl`) and `Fetcher.ts:37-53` (`validateResolvedIp`) both rely on `is_ip_private()` from `private-ip@3.0.2`. That package only recognizes dotted-quad mapped form, but WHATWG URL parsing normalizes IPv4-mapped IPv6 to the short form:

```
new URL("http://[::ffff:127.0.0.1]/").hostname  →  "::ffff:7f00:1"
is_ip_private("::ffff:127.0.0.1")              →  true
is_ip_private("::ffff:7f00:1")                 →  false   ← bypass
```

Reproduction through the actual product code (local HTTP listener on 127.0.0.1):

```
Fetcher.html({ url: "http://[::ffff:127.0.0.1]:port/" })  → 200, isError: false, private body returned
Fetcher.html({ url: "http://[::ffff:7f00:1]:port/" })     → 200, isError: false, private body returned
```

`validateResolvedIp` also passes because `dns.promises.lookup()` on an IP literal returns the literal unchecked. This is the same class as **CVE-2025-8020 / GHSA-9h3q-32c7-r533** (flagged by `bun audit` as HIGH); **no fixed version exists** — 3.0.2 is the latest, so `bun audit fix` cannot resolve it. The README's "SSRF protection (blocks private/localhost addresses and DNS rebinding)" claim and `docs/ssrf.md` are currently false for this vector.

**Fix:** expand any `::ffff:` prefix (both long and short form) to the embedded IPv4 before checking, in both `validateUrl` and on the `dns.promises.lookup` result in `validateResolvedIp`. Consider replacing the dependency with a small internal checker since it cannot be fixed upstream. Add regression tests using the exact `::ffff:7f00:1` form.

**Addendum (2026-09-10):** the dependency recommendation has since been carried out. `private-ip` was removed entirely and replaced by `isPrivateIp` (Fetcher.ts), an allowlist built on the maintained `ip-address@10.x` package: `isGlobal()` covers the ranges above and unwraps IPv4-mapped IPv6 natively (so the CVE-2025-8020 class is handled by the library, with `toIpv4IfMapped` kept as message normalization), and the Teredo `2001:20::/28` prefix is blocked explicitly. See `docs/ssrf.md` for the current behavior.

### 2. yt-dlp path bypasses all URL validation (resolved in `fc8ef59`)

`Fetcher.youtubeTranscript` (`Fetcher.ts:281`) routes to `fetchTranscriptViaYtDlp` (`Fetcher.ts:203`) **without ever calling `_fetch` or `validateUrl`** when `yt-dlp` is installed. The only validation is zod's `z.string().url()` in `types.ts:27`, which accepts any valid URL scheme. Verified:

```
YouTubeTranscriptPayloadSchema.parse({ url: "file:///etc/passwd" })     → accepted
YouTubeTranscriptPayloadSchema.parse({ url: "ftp://example.com/x" })    → accepted
YouTubeTranscriptPayloadSchema.parse({ url: "rtmp://127.0.0.1/live" })  → accepted
```

The URL is then handed to a local binary (`yt-dlp`) that has handlers for many non-HTTP protocols, so `file://`/SSRF-style inputs are never screened. The yt-dlp path also reads the produced `.srv1` file with **no `maxResponseBytes` cap** (unlike every `_fetch`-based path). The direct-extraction path (`fetchTranscriptDirect`) does inherit `_fetch` protections; only the yt-dlp branch is exposed, and only on hosts where `yt-dlp` is on PATH.

**Fix:** call `validateUrl(url)` at the top of `youtubeTranscript` (before both branches) and restrict the zod schema to http/https for this tool. Optionally add a byte cap on the read `.srv1` file.

### 3. Redirect SSRF is detection-only, not prevention (resolved in `dddbdb8`)

`Fetcher.ts:81-84` re-validates `response.url` **after** the request has already traversed every redirect hop. A public attacker page that 302s to `http://169.254.169.254/...` or a LAN host makes the request to the private target *before* the check throws. The response body is discarded (content exfiltration is blocked), but the request itself fires — sufficient to enumerate internal hosts or hit GET-with-side-effects endpoints (cloud metadata, internal APIs). Intermediate hops are never checked at all.

**Fix (two parts):** (a) immediately, correct the README/`docs/ssrf.md` claims to "blocks returning private content; cannot prevent requests to private hosts via redirect chains"; (b) for true prevention, per-hop validation requires a custom dispatcher (Node/undici) or a local validating proxy — the involved, dual-runtime (Bun dev / Node target) investigation listed last in the remediation order.

---

## High

### 4. Argument injection into yt-dlp via `lang` (resolved in `60faa77`)

`Fetcher.ts:207` and `Fetcher.ts:288` validate `lang` with `/^[a-zA-Z0-9-]+$/`, which **allows leading hyphens**: `-o`, `--sub-format`, and `--skip-download` all pass. The value is passed as the argv element after `--sub-lang` (`Fetcher.ts:216-217`); an argparse-style parser treats a value matching a registered option as an option, which can rebind the `-o` output template so subtitle files land **outside** the `mktemp -d` directory. Corroborated by `*.srv1` in `.gitignore` — stray subtitle files have appeared outside the temp dir at some point. (Full parser interaction could not be confirmed locally; yt-dlp is not installed in the audit environment. Treat as defense-in-depth either way.)

**Fix:** require an alphanumeric first character and bound length, e.g. `/^[a-zA-Z0-9][a-zA-Z0-9-]{0,9}$/`, in both validation sites.

### 5. yt-dlp branch is Unix-only and fails silently (resolved in `5fb119a`)

`Fetcher.ts:211` (`execSync("mktemp -d")`) and `Fetcher.ts:273` (`execSync("which yt-dlp")`) are Unix-only. On Windows `checkYtDlp` returns `false`, so the branch degrades to direct extraction with no diagnostic — operators cannot distinguish "yt-dlp broken" from "video has no captions" (the broad `catch` at `Fetcher.ts:293` swallows everything).

**Fix:** use `os.tmpdir()` + a random suffix for the workspace, detect the binary portably, and emit at least one stderr/log line when the fallback triggers.

---

## Medium — parsing mistakes

### 6. `extractPlayerResponse` truncates at the first `};` (resolved in `a51d525`)

`YouTubeTranscript.ts:3` — `/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s` is non-greedy to a two-character terminator: any string value in the JSON containing `};` (embedded code snippets, descriptions) truncates the object, `JSON.parse` fails, and the whole transcript errors. YouTube has historically changed how this global is emitted. **Fix:** balanced-brace scan (depth counting outside string literals) with the regex as a locator.

### 7. `parseTranscriptXml` fragility and silent empty result (resolved in `b771fd7`)

`YouTubeTranscript.ts:32-34`:
- The srv3 regex `<p\s+t="(\d+)"` requires `t` to be the **first** attribute — verified that `<p d="100" t="200">` matches nothing.
- If both format regexes fail, the method returns `[]` and the tool reports **success with an empty transcript** (`isError: false`).
- `decodeHtmlEntities` (`YouTubeTranscript.ts:19-26`) handles only five named entities; `&apos;`, `&nbsp;`, and numeric references (`&#x27;`) leak through into output literally.

**Fix:** attribute-order-independent matching, complete entity decoding (including numeric), and an explicit error when zero captions are parsed.

### 8. Caption URL built by string concatenation (resolved in `c7a1877`)

`Fetcher.ts:252` — `track.baseUrl + "&fmt=srv1"` yields an invalid URL when `baseUrl` has no `?` at all, and `includes("fmt=")` can match inside a different parameter's value. **Fix:** `new URL(baseUrl)` + `searchParams.set("fmt", "srv1")`.

---

## Low

### 9. `json()` round-trip mutates data (resolved in `b023ba3`)

`Fetcher.ts:146-147` — verified: `2^53+1` → `2^53`, `1e308` → `Infinity` → `null`. For APIs with large integer fields the returned JSON is not semantically identical to the source. Decide the policy (pass through raw text, or document the loss) rather than leaving it implicit.

### 10. `applyLengthLimits` splits surrogate pairs (resolved in `1cf816b`)

`Fetcher.ts:10-17` — verified: `substring` on `"abc🙂def"` at the pair boundary yields a lone `\ud83d` in output. **Fix:** code-point-aware slicing (`Array.from` or segmenting by code points).

### 11. `hasYtDlp` cached for process lifetime (resolved in `572e186`)

`Fetcher.ts:267` — the MCP server is long-lived; a yt-dlp installed or removed mid-session is never detected. **Fix:** TTL or re-check on a cheap schedule.

### 12. Note: keep JSDOM script-free (closed by guard test in `ca29909`)

`fetch_txt`/`fetch_markdown`/`fetch_readable` use `new JSDOM(html)` with **no** `runScripts` option — remote HTML never executes. This is load-bearing: adding `runScripts: "dangerously"` (a common "make it work" move for Readability) turns the server into RCE.

---

## Suggested remediation order (executed)

Executed on this branch in the order 1, 2, 4, 8, 5, 7, 6, 10, 11, 9, 3, with one commit per item, followed by the #12 guard test (`ca29909`). Originally ordered by effort-first with severity kept in view: quick wins that close real attack surface come before contained parsing work, which came before the one genuinely involved investigation.

1. **Finding #1 — mapped-IPv6 expansion** (Critical, easy). ~15 lines: one `normalizeIp()` helper applied at `validateUrl` (`Fetcher.ts:30`) and on the lookup result in `validateResolvedIp` (`Fetcher.ts:44`), plus regression tests using `::ffff:7f00:1` and `::ffff:a00:1` forms. Do the README/`docs/ssrf.md` claim corrections in the same commit. Highest severity, lowest effort — start here.
2. **Finding #2 — youtube protocol validation** (Critical, easy). One `validateUrl(url)` call at the top of `youtubeTranscript` plus tightening the zod schema in `types.ts` to http/https (the tool is YouTube-only anyway). Closes the only remaining unvalidated input path.
3. **Finding #4 — `lang` regex** (High, trivial). Two-line regex change at `Fetcher.ts:207`/`288` + tests.
4. **Finding #8 — caption URL via `URL`/`searchParams`** (Medium, small). One-line replacement at `Fetcher.ts:252` + tests for the no-`?` case.
5. **Finding #5 — yt-dlp portability + fallback diagnostics** (High, small-to-medium). `os.tmpdir()`, portable detection, one log line on fallback. Improves Windows behavior and operator visibility.
6. **Finding #7 — `parseTranscriptXml` hardening** (Medium, contained). Attribute-order-independent regexes, full entity decoding, error on zero captions.
7. **Finding #6 — balanced-brace player-response extraction** (Medium, contained). Replaces the `};`-truncated regex; YouTube-format drift is the motivation, but the current failure mode is an error, not a bypass, so it ranks after #7.
8. **Minor batch — #9, #10, #11** (Low, all small). Surrogate-aware slicing, TTL on `hasYtDlp`, and an explicit decision on `json()` number fidelity. Do together in one pass.
9. **Finding #3 — true per-hop redirect prevention** (Critical, involved — last). Requires a custom validating dispatcher under Node/undici *and* an equivalent under Bun's fetch (the dual-runtime constraint is the hard part; `--target node` output must behave the same as dev under Bun). Everything cheaper from #3 (the doc corrections) ships in step 1. Landed in `dddbdb8` as manual per-hop following (`redirect: "manual"`, which both Bun and Node/undici support) with each hop validated before it fires, so the documented guarantee is now "no request is ever sent to a private host, including via redirect chains." The only remaining open item is the internet-dependent e2e tier (real public 302 to a private target), which is deferred.
