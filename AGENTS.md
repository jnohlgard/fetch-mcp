# AGENTS.md

MCP server + CLI in TypeScript (Bun dev, Node runtime) for fetching web content as HTML/Markdown/text/JSON/article/YouTube transcript.

## Commands

```bash
bun install   # ALWAYS first on a fresh checkout (bun.lock is gitignored; tests fail without it)
bun test      # bun:test, 5 files in src/, 89 tests
bun run build # bundles to dist/ (only quality gate besides tests; no lint/CI)
```

## Rules that trip up agents

- Strict ESM: relative imports use `.js` extensions in `.ts` files.
- Public `Fetcher` methods never throw — they return `{ content: [{ type: "text", text }], isError }`; exact error strings are asserted in tests, don't reword them.
- `max_length: 0` means unlimited, not zero.
- New tests touching fetch must stub `dns.promises.lookup` to a public IP and reset `Fetcher.hasYtDlp` in `beforeEach` (see docs/testing.md).
- All new fetch paths go through `Fetcher._fetch` to inherit SSRF/size checks.

## Read on demand

| File | When |
|---|---|
| `docs/architecture.md` | touching entry points, adding/removing a tool or CLI subcommand |
| `docs/ssrf.md` | touching fetch, redirects, DNS, size limits, or `types.ts` env vars |
| `docs/security-findings.md` | working the fetch/SSRF boundary, the yt-dlp path, or fixing a reported vulnerability |
| `docs/testing.md` | writing or changing tests |
| `docs/youtube.md` | touching transcript/yt-dlp code |
| `docs/publishing.md` | changing package.json, bins, build, or publishing |
