# Testing patterns

Two parallel test styles per module:

- `src/<Name>.test.ts` — synthetic fixtures with heavy mocking: `globalThis.fetch` replaced by a `jest.fn()` mock (bun:test is jest-compatible — `jest.fn()`, `mockResolvedValueOnce`, `spyOn`), chained `.mockResolvedValueOnce` for sequential fetches (e.g., page then caption URL), and `spyOn(dns.promises, "lookup")` for DNS-rebinding scenarios.
- `src/<Name>.fixture.test.ts` — real captured payloads (actual YouTube srv1/srv3 XML, realistic player-response JSON) driven through the **real** JSDOM/Turndown/Readability code paths, asserting exact formatted output.

Mandatory setup in any test file that exercises `Fetcher._fetch`:

```ts
// neutralize SSRF checks: stub DNS to a public IP, restore in afterAll/afterEach
dns.promises.lookup = (async () => ({ address: "93.184.216.34", family: 4 })) as any;
```

and reset `Fetcher.hasYtDlp = false` in `beforeEach` (the check is cached per process).

`cli.test.ts` monkeypatches `process.exit` (made to throw `"EXIT"`), `process.stdout.write`, and `process.stderr.write` to capture exit codes and output; originals saved at module top, restored in `afterAll`.

Test files are colocated in `src/` and excluded from the build by tsconfig.

## Error-message contracts

Tests assert exact message strings — don't change them casually:

- fetch failures: `Failed to fetch {url}: {message}` (or `: Unknown error`)
- non-2xx: `Failed to fetch {url}: HTTP error: {status}`
- size limit: `Response too large: ...`
- SSRF-block errors must **not** be wrapped in the `Failed to fetch` prefix (tests assert `.not.toContain("Failed to fetch")`).
