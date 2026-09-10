Work in the repo /projects/fetch-mcp on branch `fix/security-findings`.

You are the CLOSING session of the ordered TDD remediation of the security audit in docs/security-findings.md. All 11 findings are now committed on this branch (in the order 1, 2, 4, 8, 5, 7, 6, 10, 11, 9, 3). Your job is verification, one small guard test, and doc closeout. Do not rework completed fixes. Do not open a PR.

Ground rules
- If node_modules is missing, run `bun install` first. bun.lock is gitignored, so a fresh checkout fails `bun test` without it.
- Before starting: `git status` must be clean and `bun test` must be all green. If either is not true, stop and report what you found.
- Commit format: conventional style, subject under 72 chars, a short body explaining why, and the trailer line `Assisted-by: Crush:qwen3.8-27b`. Use a quoted heredoc like the existing commits (check `git log` for the exact pattern). Never push, never merge, never amend history.
- Code style: no em dashes and no semicolons in code, comments, or user-facing text. Older docs already contain a few. Do not add new ones.
- Test conventions: bun:test with the jest-compat API. Mock fetch responses are plain objects like `{ ok: true, text: jest.fn().mockResolvedValueOnce("...") }` with no `body` property. The test files' `beforeEach` install the mock fetch, a public-IP DNS stub, and `Fetcher.hasYtDlp = false`.

---

## Task: final sweep

1. Run the full `bun test` and `bun run build`. Both must be clean. If anything is red, fix it minimally in its own `fix:` commit before continuing.
2. Finding #12 is the only finding without a fix commit. It is a note: the JSDOM-based tools (`fetch_txt`, `fetch_markdown`, `fetch_readable`) must stay script-free, because adding `runScripts: "dangerously"` (a common "make it work" move for Readability) would turn the server into RCE. Add a regression guard test in src/Fetcher.test.ts: call `Fetcher.txt` (and one more of the three, e.g. `readable`) on HTML containing `<script>document.body.textContent += "PWNED"</script>`, and assert the output does NOT contain `PWNED`. That fails if anyone later enables script execution. TDD as usual (the test passes today too, since JSDOM is already script-free. It is a guard, not a bug fix. Write it, confirm it passes, and commit). Commit it as `test: guard against enabling JSDOM script execution` with the standard trailer.
3. Update docs/security-findings.md: mark every finding resolved and cite the commit hash that closed it (`git log --oneline main..fix/security-findings` lists them all). For #12, cite the guard-test commit from step 2.
4. Cross-check the docs against the final behavior and correct stale statements: README (feature list and any YouTube or transcript claims), docs/ssrf.md, docs/youtube.md, docs/testing.md, and docs/security-test-plan.md (internet-dependent e2e tiers should be marked deferred, not pending).
5. Check for leftovers: stray `*.srv1` files in the repo, unused imports introduced by the items, debug logging left behind. Clean them up in a small `chore:` commit if they are code, or fold them into the docs commit.
6. Final commit: `docs: mark all security findings resolved and sync the docs` with the standard trailer.

When done, stop and report: the last lines of `bun test`, the output of `git log --oneline main..fix/security-findings`, and a one-paragraph summary ready to paste into a PR description (why each class of finding mattered, what now prevents it, and what remains deferred).
