# Build and publishing

- `bun run build` uses `bun build --target node` with `--external jsdom --external @mozilla/readability --external turndown`. Those three stay as npm runtime dependencies (they're heavy); everything else is bundled. Output is ~1.3 MB for `index.js` (grew with the SDK v2 upgrade).
- npm package `@jnohlgard/fetch-mcp` exposes one bin: `fetch-mcp` (→ `dist/index.js`). `serve` starts the stdio MCP server; any other subcommand runs the CLI. `files` ships only `dist`, `README.md`, `LICENSE`. `prepublishOnly` re-runs the build.
- Version is bumped manually in `package.json` (no release automation).
- Publishing: bump the version, commit, tag `v{version}`, then create a GitHub Release on that tag. The `release: published` event triggers `.github/workflows/publish.yml`, which verifies the tag matches the `package.json` version, runs `bun test`, and runs `npm publish --access public` using the `NPM_TOKEN` repo secret.
- TypeScript is strict ESM (`"type": "module"`, `moduleResolution: "bundler"`); relative imports in `.ts` files use the `.js` extension (`import { Fetcher } from "./Fetcher.js"`).
