# Architecture

```
src/types.ts              env config + zod arg schemas (single source of defaults)
src/Fetcher.ts            ALL fetch/transform logic (static class; only state: hasYtDlp cache)
src/YouTubeTranscript.ts  pure helpers: player-response extraction, caption XML parsing
src/index.ts              single entry point: "serve" starts the MCP stdio server (SDK v2, createFetchServer()); any other subcommand dispatches to the CLI
src/cli.ts                CLI implementation: arg parsing + subcommand→Fetcher dispatch (imported by index.ts)
```

- Both halves of the entry point are thin dispatch layers over the same static `Fetcher` methods. Never duplicate fetch logic between `index.ts` and `cli.ts`.
- Shared result contract: every public `Fetcher` method returns `{ content: [{ type: "text", text }], isError }` and **never throws**. `index.ts` passes this straight to the MCP transport; `cli.ts` routes `isError` to stderr + exit(1), success to stdout.
- Naming split: MCP tools are snake_case with `fetch_` prefix (`fetch_html`); CLI subcommands are short (`html`); payload fields are snake_case (`max_length`); CLI flags are kebab-case (`--max-length`). The tool→method map is in `cli.ts` `run()`; zod schemas in `types.ts`.
- Only `index.ts` is an entry point, and it dispatches only when `isMainModule()` passes (realpath comparison of `process.argv[1]`), so importing it (e.g. from tests) is safe. `cli.ts` has no side effects on import. Keep that guard; `createFetchServer`, `parseArgs`, and `run` are exported for tests.

## Adding a new tool/subcommand

1. Add a static method to `Fetcher` returning the standard result shape.
2. Add zod schema + payload type in `types.ts` if the args differ from `RequestPayload`.
3. Register in `index.ts`: a `tools/list` entry (hand-written JSON schema) and a `tools/call` dispatch branch.
4. Register in `cli.ts`: `SUBCOMMANDS`, the `run()` fetcher map, and flag parsing if it takes new flags.
5. Update README (tools table, CLI tables, examples).
6. Add both a `*.test.ts` (mocked) and `*.fixture.test.ts` (real payloads) test file.
