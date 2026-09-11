import { Fetcher } from "./Fetcher.js";
import { isHttpProtocol, type RequestPayload, type TextToolResult } from "./types.js";
import pkg from "../package.json" with { type: "json" };

const USAGE = `fetch-mcp v${pkg.version}

Usage: fetch-mcp <command> <url> [flags]

Commands:
  serve     Start the MCP server over stdio
  html      Fetch a URL and return raw HTML
  markdown  Fetch a URL and return Markdown
  readable  Fetch a URL and return article content as Markdown (via Readability)
  txt       Fetch a URL and return plain text
  json      Fetch a URL and return JSON
  youtube   Fetch a YouTube video transcript

Flags:
  --max-length <N>   Maximum characters to return
  --start-index <N>  Start from this character index
  --proxy <URL>      Proxy URL (Bun only; silently ignored on Node)
  --lang <code>      Language code for YouTube transcripts (default: en)
  --help             Show this help message
  --version          Show version
`;

const SUBCOMMANDS = ["html", "markdown", "readable", "txt", "json", "youtube"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

export interface ParsedArgs {
  subcommand: Subcommand;
  url: string;
  maxLength?: number;
  startIndex?: number;
  proxy?: string;
  lang?: string;
}

// Shared value validators for the two shapes of flags: non-negative integers
// and plain strings (a following "--" or missing value is an error).
function setIntFlag(result: ParsedArgs, field: "maxLength" | "startIndex", flag: string, value: string | undefined): void {
  const parsed = parseInt(value ?? "", 10);
  if (isNaN(parsed) || parsed < 0) {
    process.stderr.write(`${flag} requires a non-negative integer\n`);
    process.exit(1);
  }
  result[field] = parsed;
}

function setStringFlag(result: ParsedArgs, field: "proxy" | "lang", flag: string, value: string | undefined): void {
  if (!value || value.startsWith("--")) {
    process.stderr.write(`${flag} requires a value\n`);
    process.exit(1);
  }
  result[field] = value;
}

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0 || argv.includes("--help")) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  if (argv.includes("--version")) {
    process.stdout.write(pkg.version + "\n");
    process.exit(0);
  }

  const subcommand = argv[0] as string;
  if (!SUBCOMMANDS.includes(subcommand as Subcommand)) {
    process.stderr.write(`Unknown command: ${subcommand}\n\n${USAGE}`);
    process.exit(1);
  }

  const url = argv[1];
  if (!url || url.startsWith("--")) {
    process.stderr.write(`Missing URL for "${subcommand}" command\n`);
    process.exit(1);
  }
  try {
    const parsed = new URL(url);
    if (!isHttpProtocol(parsed.protocol)) {
      process.stderr.write(`Invalid URL protocol "${parsed.protocol}". Only http: and https: are allowed.\n`);
      process.exit(1);
    }
  } catch {
    process.stderr.write(`Invalid URL: ${url}\n`);
    process.exit(1);
  }

  const result: ParsedArgs = { subcommand: subcommand as Subcommand, url };

  const FLAGS: Record<string, (flag: string, value: string | undefined) => void> = {
    "--max-length": (flag, value) => setIntFlag(result, "maxLength", flag, value),
    "--start-index": (flag, value) => setIntFlag(result, "startIndex", flag, value),
    "--proxy": (flag, value) => setStringFlag(result, "proxy", flag, value),
    "--lang": (flag, value) => setStringFlag(result, "lang", flag, value),
  };

  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const handler = FLAGS[flag];
    if (!handler) {
      process.stderr.write(`Unknown flag: ${flag}\n`);
      process.exit(1);
    }
    handler(flag, argv[i + 1]);
    i++;
  }

  return result;
}

export async function run(args: ParsedArgs): Promise<void> {
  const fetchers: Record<string, (p: RequestPayload) => Promise<TextToolResult>> = {
    html: Fetcher.html.bind(Fetcher),
    markdown: Fetcher.markdown.bind(Fetcher),
    readable: Fetcher.readable.bind(Fetcher),
    txt: Fetcher.txt.bind(Fetcher),
    json: Fetcher.json.bind(Fetcher),
    youtube: Fetcher.youtubeTranscript.bind(Fetcher),
  };

  const payload: RequestPayload & { lang?: string } = { url: args.url };
  if (args.maxLength !== undefined) payload.max_length = args.maxLength;
  if (args.startIndex !== undefined) payload.start_index = args.startIndex;
  if (args.proxy) payload.proxy = args.proxy;
  if (args.lang) payload.lang = args.lang;

  const result = await fetchers[args.subcommand](payload);
  const text = result.content[0].text;

  if (result.isError) {
    process.stderr.write(text + "\n");
    process.exit(1);
  }

  process.stdout.write(text);
}
