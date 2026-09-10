#!/usr/bin/env node

import { Server, type ListToolsResult } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { RequestPayloadSchema, YouTubeTranscriptPayloadSchema } from "./types.js";
import { Fetcher } from "./Fetcher.js";
import process from "process";
import { downloadLimit } from "./types.js";
import pkg from "../package.json" with { type: "json" };
import { realpathSync } from "fs";
import { fileURLToPath } from "url";

export function createFetchServer(): Server {
  const server = new Server(
    {
      name: "zcaceres/fetch",
      version: pkg.version,
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
    },
  );

  server.setRequestHandler("tools/list", async (): Promise<ListToolsResult> => {
    return {
      tools: [
        {
          name: "fetch_html",
          description: "Fetch a website and return its unmodified contents as HTML",
          inputSchema: {
            type: "object",
            properties: {
              url: {
                type: "string",
                description: "URL of the website to fetch",
              },
              headers: {
                type: "object",
                description: "Optional headers to include in the request",
              },
              max_length: {
                type: "number",
                description: `Maximum number of characters to return (default: ${downloadLimit})`,
              },
              start_index: {
                type: "number",
                description: "Start content from this character index (default: 0)",
              },
              proxy: {
                type: "string",
                description: "Optional proxy URL (e.g. 'http://proxy:8080'). Only honored when the server runs under Bun; silently ignored on Node.",
              },
            },
            required: ["url"],
          },
        },
        {
          name: "fetch_markdown",
          description: "Fetch a website and return its contents converted to Markdown",
          inputSchema: {
            type: "object",
            properties: {
              url: {
                type: "string",
                description: "URL of the website to fetch",
              },
              headers: {
                type: "object",
                description: "Optional headers to include in the request",
              },
              max_length: {
                type: "number",
                description: `Maximum number of characters to return (default: ${downloadLimit})`,
              },
              start_index: {
                type: "number",
                description: "Start content from this character index (default: 0)",
              },
              proxy: {
                type: "string",
                description: "Optional proxy URL (e.g. 'http://proxy:8080'). Only honored when the server runs under Bun; silently ignored on Node.",
              },
            },
            required: ["url"],
          },
        },
        {
          name: "fetch_txt",
          description:
            "Fetch a website, convert the content to plain text (no HTML)",
          inputSchema: {
            type: "object",
            properties: {
              url: {
                type: "string",
                description: "URL of the website to fetch",
              },
              headers: {
                type: "object",
                description: "Optional headers to include in the request",
              },
              max_length: {
                type: "number",
                description: `Maximum number of characters to return (default: ${downloadLimit})`,
              },
              start_index: {
                type: "number",
                description: "Start content from this character index (default: 0)",
              },
              proxy: {
                type: "string",
                description: "Optional proxy URL (e.g. 'http://proxy:8080'). Only honored when the server runs under Bun; silently ignored on Node.",
              },
            },
            required: ["url"],
          },
        },
        {
          name: "fetch_json",
          description: "Fetch a JSON file from a URL",
          inputSchema: {
            type: "object",
            properties: {
              url: {
                type: "string",
                description: "URL of the JSON to fetch",
              },
              headers: {
                type: "object",
                description: "Optional headers to include in the request",
              },
              max_length: {
                type: "number",
                description: `Maximum number of characters to return (default: ${downloadLimit})`,
              },
              start_index: {
                type: "number",
                description: "Start content from this character index (default: 0)",
              },
              proxy: {
                type: "string",
                description: "Optional proxy URL (e.g. 'http://proxy:8080'). Only honored when the server runs under Bun; silently ignored on Node.",
              },
            },
            required: ["url"],
          },
        },
        {
          name: "fetch_readable",
          description:
            "Fetch a website and return its main content parsed by Mozilla Readability, converted to Markdown. Strips away navigation, ads, and boilerplate. Ideal for articles and blog posts.",
          inputSchema: {
            type: "object",
            properties: {
              url: {
                type: "string",
                description: "URL of the website to fetch",
              },
              headers: {
                type: "object",
                description: "Optional headers to include in the request",
              },
              max_length: {
                type: "number",
                description: `Maximum number of characters to return (default: ${downloadLimit})`,
              },
              start_index: {
                type: "number",
                description: "Start content from this character index (default: 0)",
              },
              proxy: {
                type: "string",
                description: "Optional proxy URL (e.g. 'http://proxy:8080'). Only honored when the server runs under Bun; silently ignored on Node.",
              },
            },
            required: ["url"],
          },
        },
        {
          name: "fetch_youtube_transcript",
          description:
            "Fetch a YouTube video page and extract its captions/transcript",
          inputSchema: {
            type: "object",
            properties: {
              url: {
                type: "string",
                description: "URL of the YouTube video",
              },
              headers: {
                type: "object",
                description: "Optional headers to include in the request",
              },
              max_length: {
                type: "number",
                description: `Maximum number of characters to return (default: ${downloadLimit})`,
              },
              start_index: {
                type: "number",
                description: "Start content from this character index (default: 0)",
              },
              proxy: {
                type: "string",
                description: "Optional proxy URL (e.g. 'http://proxy:8080'). Only honored when the server runs under Bun; silently ignored on Node.",
              },
              lang: {
                type: "string",
                description: "Language code for captions (default: 'en')",
              },
            },
            required: ["url"],
          },
        },
      ],
    };
  });

  const FETCH_TOOLS = new Set(["fetch_html", "fetch_json", "fetch_txt", "fetch_markdown", "fetch_readable"]);

  server.setRequestHandler("tools/call", async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "fetch_youtube_transcript") {
      const validatedArgs = YouTubeTranscriptPayloadSchema.parse(args);
      return Fetcher.youtubeTranscript(validatedArgs);
    }

    if (!FETCH_TOOLS.has(name)) {
      throw new Error(`Tool not found: ${name}`);
    }

    const validatedArgs = RequestPayloadSchema.parse(args);

    if (name === "fetch_html") return Fetcher.html(validatedArgs);
    if (name === "fetch_json") return Fetcher.json(validatedArgs);
    if (name === "fetch_txt") return Fetcher.txt(validatedArgs);
    if (name === "fetch_markdown") return Fetcher.markdown(validatedArgs);
    return Fetcher.readable(validatedArgs);
  });

  return server;
}

async function main() {
  const server = createFetchServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function isMainModule(): boolean {
  try {
    const scriptPath = fileURLToPath(import.meta.url);
    const argPath = realpathSync(process.argv[1]);
    return scriptPath === argPath;
  } catch {
    return process.argv[1]?.endsWith("/index.js") || process.argv[1]?.endsWith("/mcp-fetch-server") || false;
  }
}

if (isMainModule()) {
  main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
  });
}
