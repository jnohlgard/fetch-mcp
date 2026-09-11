# Fetch MCP Server

![fetch mcp logo](logo.jpg)

[![npm version](https://img.shields.io/npm/v/%40jnohlgard%2Ffetch-mcp.svg)](https://www.npmjs.com/package/@jnohlgard/fetch-mcp)

An MCP server for fetching web content in multiple formats — HTML, JSON, plain text, Markdown, readable article content, and YouTube transcripts.

<a href="https://glama.ai/mcp/servers/nu09wf23ao">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/nu09wf23ao/badge" alt="Fetch Server MCP server" />
</a>

## Tools

All tools accept the following common parameters:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | URL to fetch |
| `headers` | object | No | Custom headers to include in the request |
| `max_length` | number | No | Maximum characters to return (default: 5000) |
| `start_index` | number | No | Start from this character index (default: 0) |
| `proxy` | string | No | Proxy URL (e.g. `http://proxy:8080`) — only honored when running under Bun |

> **Note:** `proxy` is a Bun-specific `fetch()` option. It is silently ignored when the server runs on Node (the default `npx` install path), so requests go direct in that case.

- **fetch_html** — Fetch a website and return its raw HTML content.

- **fetch_markdown** — Fetch a website and return its content converted to Markdown.

- **fetch_txt** — Fetch a website and return plain text with HTML tags, scripts, and styles removed.

- **fetch_json** — Fetch a URL and return the JSON response.

- **fetch_readable** — Fetch a website and extract the main article content using [Mozilla Readability](https://github.com/mozilla/readability), returned as Markdown. Strips navigation, ads, and boilerplate. Ideal for articles and blog posts. Accepts an optional `fallback` parameter (`"markdown"`, `"txt"`, or `"none"`, default `"none"`): when no article can be extracted, the whole page is returned in the fallback format instead of an error.

- **fetch_youtube_transcript** — Fetch a YouTube video's captions/transcript. Uses `yt-dlp` if available, otherwise extracts directly from the page. Accepts an additional `lang` parameter (default: `"en"`) to select the caption language.

## Installation

### As an MCP server

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "fetch": {
      "command": "npx",
      "args": ["@jnohlgard/fetch-mcp"]
    }
  }
}
```

### As a CLI

```bash
npx -p @jnohlgard/fetch-mcp mcp-fetch <command> <url> [flags]
```

Or install globally:

```bash
npm install -g @jnohlgard/fetch-mcp
mcp-fetch <command> <url> [flags]
```

## CLI Usage

```
mcp-fetch <command> <url> [flags]
```

### Commands

| Command | Description |
|---------|-------------|
| `html` | Fetch a URL and return raw HTML |
| `markdown` | Fetch a URL and return Markdown |
| `readable` | Fetch a URL and return article content as Markdown (via Readability) |
| `txt` | Fetch a URL and return plain text |
| `json` | Fetch a URL and return JSON |
| `youtube` | Fetch a YouTube video transcript |

### Flags

| Flag | Description |
|------|-------------|
| `--max-length <N>` | Maximum characters to return |
| `--start-index <N>` | Start from this character index |
| `--proxy <URL>` | Proxy URL (only honored when running under Bun) |
| `--lang <code>` | Language code for YouTube transcripts (default: `en`) |
| `--help` | Show help message |
| `--version` | Show version |

### Examples

```bash
# Fetch a page as markdown
mcp-fetch markdown https://example.com

# Extract article content without boilerplate
mcp-fetch readable https://example.com/blog/post

# Get a YouTube transcript in Spanish
mcp-fetch youtube https://www.youtube.com/watch?v=dQw4w9WgXcQ --lang es

# Fetch with a length limit
mcp-fetch html https://example.com --max-length 10000

# Fetch through a proxy (Bun only — silently ignored when running on Node)
mcp-fetch json https://api.example.com/data --proxy http://proxy:8080
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DEFAULT_LIMIT` | Default character limit for responses (default: `5000`, set to `0` for no limit) |
| `MAX_RESPONSE_BYTES` | Maximum response body size in bytes (default: `10485760` / 10 MB) |
| `FETCH_TIMEOUT_MS` | Per-request timeout in milliseconds. Each redirect hop gets its own budget (default: `30000` / 30 s) |
| `FETCH_CAPTION_TIMEOUT_MS` | Timeout for the auxiliary YouTube caption fetch (default: `10000` / 10 s) |
| `MAX_CONCURRENT_FETCHES` | Max concurrent outbound fetches in this process; extra requests queue until a slot frees up (default: `10`, set to `0` for unlimited) |
| `PARSE_TIMEOUT_MS` | Deadline for HTML parsing (jsdom/Readability/Turndown) in `fetch_txt`/`fetch_readable` in milliseconds; a clear error is returned when parsing outlives the deadline (default: `10000` / 10 s) |
| `FETCH_LOGGING` | Structured per-request log line on stderr (host, status, duration, bytes) for correlating agent behavior with egress; only the host is ever logged, never the URL path, query, or headers (default: on, set to `0` to disable) |

Example with a custom limit:

```json
{
  "mcpServers": {
    "fetch": {
      "command": "npx",
      "args": ["@jnohlgard/fetch-mcp"],
      "env": {
        "DEFAULT_LIMIT": "50000"
      }
    }
  }
}
```

## Features

- Fetch web content as HTML, JSON, plain text, or Markdown
- Extract article content with Mozilla Readability (strips ads, nav, boilerplate)
- Extract YouTube video transcripts (via `yt-dlp` or direct extraction)
- Proxy support for requests behind firewalls (Bun only; silently ignored when running on Node)
- Pagination with `max_length` and `start_index`
- Custom request headers
- SSRF protection (blocks private/localhost addresses, IPv4-mapped IPv6 addresses, DNS-rebinding to private IPs on the first resolution, and every redirect hop before it fires)
- Credential headers (`Authorization`, `Cookie`, `Proxy-Authorization`) are stripped from redirect hops that cross to a different origin
- Response size limits to prevent memory exhaustion
- Per-request timeouts (30 s per redirect hop, 10 s for the YouTube caption fetch) so a hung or slowloris connection cannot block a request indefinitely
- Structured per-request logging on stderr (host, status, duration, bytes) for correlating agent behavior with cluster egress; only the host is ever logged, never the URL path, query, or headers

## Development

```bash
bun install
bun run dev     # start with watch mode
bun test        # run tests
bun run build   # build for production
```

## License

This project is licensed under the MIT License.
