# SSRF protection and size limits

`_fetch` (Fetcher.ts:98) performs three checks; any new fetch path must go through `_fetch` to inherit them:

1. `validateUrl`: http/https only (blocks `file:`, `data:`, `ftp:`); strips IPv6 brackets; rejects `localhost` and non-global addresses via `isPrivateIp` (Fetcher.ts), an allowlist built on the maintained `ip-address` package: only IANA "global unicast" passes, so private, loopback, link-local, CGNAT, documentation, benchmarking, reserved, unspecified, and multicast ranges are all blocked. IPv4-mapped IPv6 unwraps natively (`::ffff:7f00:1` reads as loopback — the CVE-2025-8020 class, which `toIpv4IfMapped` still also normalizes for error-message clarity). Teredo `2001:20::/28` is blocked explicitly because IANA classifies it as global but it embeds an attacker-controlled IPv4.
2. `validateResolvedIp`: DNS-lookup the hostname, reject private resolved IPs (DNS-rebinding defense). The same mapped-IPv6 expansion is applied to the resolved address. Subtle but load-bearing: it swallows lookup failures **only if** the error is not a `Fetcher blocked` error (Fetcher.ts) — a lookup that resolved to a private IP must propagate, not be treated as a DNS failure.
3. Redirects are followed manually (`redirect: "manual"`, supported by both Bun and Node/undici): each hop is resolved against the current URL, validated with `validateUrl` plus `validateResolvedIp`, and only then fetched, so a public host that 302-redirects to a private host never receives a request. The chain is capped at 20 hops (past the cap, an error containing `too many redirects` is thrown), each 3xx body is cancelled so the socket does not leak, and a 3xx with no `location` header is treated as an HTTP error. The final `response.url` re-check remains as a backstop.

Known limitation (by design, pre-check only): the DNS lookup and the fetch's own resolution are not pinned together, so a TOCTOU rebinding race window remains. There is no custom dispatcher/lookup option wired into `fetch`.

## Size limits

- `MAX_RESPONSE_BYTES` (default 10 MB, read once at import in `types.ts`): checked via `content-length` pre-check and per-chunk counting in `readResponseText` (reader cancelled in `finally`).
- `DEFAULT_LIMIT` (default 5000): default for `max_length`; embedded in tool descriptions and CLI usage text. **`max_length: 0` means unlimited** (`applyLengthLimits` only truncates when `maxLength > 0`) — tests use `0` to get full content.
- Both env vars are parsed once at import time (module-level consts in `types.ts`): changes require a process restart, and tests that set them must do so before importing `types`.
