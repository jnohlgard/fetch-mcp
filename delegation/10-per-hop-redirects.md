Work in the repo /projects/fetch-mcp on branch `fix/security-findings`.

You are the LAST session in the ordered TDD remediation of the security audit in docs/security-findings.md. All other findings (#1, #2, #4, #8, #5, #7, #6, #10, #11, #9) are already done on this branch. This brief covers finding #3, the one genuinely involved item. Do not work on any other finding, do not restructure shared code, and do not open a PR.

Ground rules
- If node_modules is missing, run `bun install` first. bun.lock is gitignored, so a fresh checkout fails `bun test` without it.
- Before starting: `git status` must be clean and `bun test` must be all green. If either is not true, stop and report what you found. Do not fix other sessions' work.
- Strict TDD: (1) write the failing tests specified below, (2) run `bun test` and confirm the new tests fail for the right reason while every existing test still passes, (3) implement the minimal fix, (4) confirm the new tests pass, (5) run the full `bun test` until everything is green, (6) make one commit (code plus the doc updates below).
- Commit format: conventional style (`fix: ...`), subject under 72 chars, a short body explaining why, and the trailer line `Assisted-by: Crush:qwen3.8-27b`. Use a quoted heredoc like the existing commits (check `git log` for the exact pattern). Exactly one commit for this item. Never push, never merge, never amend history.
- Never add dependencies, never reformat, never touch files outside this item's scope.
- Code style: no em dashes and no semicolons in code, comments, or user-facing text. Older docs already contain a few. Do not add new ones.
- Environment: no internet and no external DNS. Loopback networking works. All new tests use the mocked global fetch and must not need the network.
- Test conventions: bun:test with the jest-compat API (`jest.fn`, `spyOn`). Mock fetch responses are plain objects with no `body` property. The file's `beforeEach` installs the mock fetch, a public-IP DNS stub, and `Fetcher.hasYtDlp = false`.
- Line numbers in this brief are hints from when the audit was written. Locate code by symbol name first.

---

## Task: Finding #3: redirect chains are validated only after every hop has fired (Critical)

Context
`Fetcher._fetch` (src/Fetcher.ts) runs the request with the runtime's built-in redirect following and only afterwards re-validates `response.url`. Every hop in a redirect chain has already sent a request by then. A public host that 302s to `http://127.0.0.1/...` (or a mapped-IPv6 form) still reaches the private host. The final response is rejected, but the private request happened, including anything the private server received on it. The README and docs/ssrf.md currently state this limitation honestly (softened by the finding #1 commit). This item closes it and restores the full claims.

Design decision already made: manual redirect following with `redirect: "manual"`, not a custom dispatcher. Both Bun's fetch and Node/undici's fetch support `redirect: "manual"`, which satisfies the dual-runtime constraint (the `--target node` build must behave the same as dev under Bun). No new dependencies.

Failing tests to write first (src/Fetcher.test.ts, extend the `SSRF protection` describe. Keep the existing two redirect tests green)

1. "validates a redirect target before the hop fires". Request a normal public URL. The single mock fetch returns:

    { ok: false, status: 302, headers: new Headers({ location: "http://[::ffff:127.0.0.1]/x" }) }

(You may also give it `text: jest.fn().mockResolvedValueOnce("")` in case the code touches the body.) Assert: `mockFetch` was called exactly ONCE, `isError === true`, and the message contains `private address` and NOT `Failed to fetch`. Today the code produces `Failed to fetch ...: HTTP error: 302` for this input, so the message assertion is the discriminator that makes this test fail first.
2. "follows a public redirect chain and returns the final content". A chain of three mocks: a 302 with location `https://b.example.com/one`, then a 302 with location `https://c.example.com/final`, then `{ ok: true, text: "final content" }`. Assert `isError === false`, the final text, exactly three `mockFetch` calls, and that they hit the expected URLs in order.
3. "rejects an endless redirect loop with a bounded error". Mock fetch to ALWAYS return a 302 pointing at a URL in a two-URL cycle. Assert `isError === true`, the message mentions the redirect limit (word it like `too many redirects`), and the fetch call count is bounded by the hop cap plus one (definitely not thousands).

Do NOT add a real-internet end-to-end redirect test (this environment has no internet. That tier is already marked deferred in docs/security-test-plan.md, and you should keep it marked deferred).

Fix
Rewrite `_fetch` to follow redirects manually:
1. `fetch(currentUrl, { headers, redirect: "manual", ...(proxy ? { proxy } : {}) })` (keep the existing User-Agent and headers handling).
2. While the response status is 301, 302, 303, 307, or 308 and the hop count is below the cap (use 20): read the `location` header. If it is absent, throw `Failed to fetch {currentUrl}: HTTP error: {status}`. Resolve it with `new URL(location, currentUrl)`. Run `this.validateUrl(next)` and `await this.validateResolvedIp(next)` BEFORE fetching it (they throw the standard `private address` and `resolved to private IP` messages, which the tool-level catches turn into `isError` results). Cancel the 3xx body (`response.body?.cancel().catch(() => {})`) so the socket does not leak. Increment the hop count and loop.
3. Past the hop cap: throw an error whose message contains `too many redirects`.
4. After the loop, keep the existing final `response.url !== url` re-check (belt and suspenders) and the existing `!response.ok` and size-limit logic, and return the response.

The existing mock-based redirect tests (`should block redirects to private IPs`, `should allow redirects to public URLs`) return `ok: true` with no 3xx status, so they never enter the follow loop and must stay green unchanged.

Docs (same commit)
- README: restore the full SSRF claim in the features bullet (currently softened by the finding #1 commit). It now covers the initial request, DNS rebinding on the first resolution, and every redirect hop before it fires.
- docs/ssrf.md: rewrite point 3 to describe the manual per-hop validation: `redirect: "manual"`, each hop runs `validateUrl` plus `validateResolvedIp` before the request, a hop cap of 20, the 3xx body is cancelled, and the final `response.url` re-check remains as a backstop. Remove the "detection-only" caveat that the finding #1 commit added.

Commit
`fix: validate every redirect hop before it fires`
Body: `_fetch` validated the final URL only after the runtime had already fetched every hop, so a public 302 could still reach private hosts. Redirects are now followed manually (`redirect: "manual"`, supported by both Bun and Node/undici): each hop is validated with `validateUrl` and `validateResolvedIp` before the request, the chain is bounded to 20 hops, and each 3xx body is cancelled. The final `response.url` re-check stays as a backstop. The README and docs/ssrf.md claims are restored to full strength. The real-internet e2e tier (public host 302 to a private one) remains deferred because this environment has no internet.

When done, stop and report: the commit hash, the tests you added, the last lines of `bun test`, and any deviation from this brief.
