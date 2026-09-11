# Build and publishing

- `bun run build` uses `bun build --target node` with `--external jsdom --external @mozilla/readability --external turndown`. Those three stay as npm runtime dependencies (they're heavy); everything else is bundled. Output is ~1.3 MB for `index.js` (grew with the SDK v2 upgrade).
- npm package `@jnohlgard/fetch-mcp` exposes two bins: `mcp-fetch-server` (→ `dist/index.js`, the MCP server) and `mcp-fetch` (→ `dist/cli.js`). `files` ships only `dist`, `README.md`, `LICENSE`. `prepublishOnly` re-runs the build.
- Version is bumped manually in `package.json` (no release automation).
- TypeScript is strict ESM (`"type": "module"`, `moduleResolution: "bundler"`); relative imports in `.ts` files use the `.js` extension (`import { Fetcher } from "./Fetcher.js"`).
