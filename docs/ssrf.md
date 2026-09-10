# SSRF protection and size limits

`_fetch` (Fetcher.ts:55) performs three checks; any new fetch path must go through `_fetch` to inherit them:

1. `validateUrl`: http/https only (blocks `file:`, `data:`, `ftp:`); strips IPv6 brackets; rejects `localhost` and private IPs via the `private-ip` package. Mapped-IPv6 addresses (`::ffff:a.b.c.d` and `::ffff:XXXX:YYYY`) are expanded to their embedded IPv4 by `toIpv4IfMapped` before the check, because `private-ip` does not understand those forms (this was CVE-2025-8020).
2. `validateResolvedIp`: DNS-lookup the hostname, reject private resolved IPs (DNS-rebinding defense). The same mapped-IPv6 expansion is applied to the resolved address. Subtle but load-bearing: it swallows lookup failures **only if** the error is not a `Fetcher blocked` error (Fetcher.ts) — a lookup that resolved to a private IP must propagate, not be treated as a DNS failure.
3. After fetch, `response.url` is re-validated when it differs from the request URL. This is detect-only: every redirect hop in the chain has already fired before the check runs, so a public host that 302-redirects to a private host still receives the hop requests. Per-hop validation (manual redirect following) is tracked as a follow-up finding.

Known limitation (by design, pre-check only): the DNS lookup and the fetch's own resolution are not pinned together, so a TOCTOU rebinding race window remains. There is no custom dispatcher/lookup option wired into `fetch`.

## Size limits

- `MAX_RESPONSE_BYTES` (default 10 MB, read once at import in `types.ts`): checked via `content-length` pre-check and per-chunk counting in `readResponseText` (reader cancelled in `finally`).
- `DEFAULT_LIMIT` (default 5000): default for `max_length`; embedded in tool descriptions and CLI usage text. **`max_length: 0` means unlimited** (`applyLengthLimits` only truncates when `maxLength > 0`) — tests use `0` to get full content.
- Both env vars are parsed once at import time (module-level consts in `types.ts`): changes require a process restart, and tests that set them must do so before importing `types`.
