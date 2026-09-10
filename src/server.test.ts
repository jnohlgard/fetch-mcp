import { describe, it, expect, beforeAll, afterAll, beforeEach, jest } from "bun:test";
import dns from "node:dns";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createFetchServer } from "./index.js";
import { Fetcher } from "./Fetcher.js";
import pkg from "../package.json" with { type: "json" };

const originalFetch = globalThis.fetch;
const originalLookup = dns.promises.lookup;

const mockFetch = jest.fn();

afterAll(() => {
  globalThis.fetch = originalFetch;
  dns.promises.lookup = originalLookup;
});

describe("MCP server surface", () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFetchServer();
  const client = new Client({ name: "test-client", version: "1.0.0" });

  beforeAll(async () => {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    globalThis.fetch = mockFetch as any;
    Fetcher.hasYtDlp = false;
    dns.promises.lookup = (async () => ({ address: "93.184.216.34", family: 4 })) as any;
  });

  it("completes the initialize handshake and reports server info", () => {
    expect(client.getServerVersion()).toEqual({
      name: "zcaceres/fetch",
      version: pkg.version,
    });
  });

  it("lists all six tools with their input schemas", async () => {
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name)).toEqual([
      "fetch_html",
      "fetch_markdown",
      "fetch_txt",
      "fetch_json",
      "fetch_readable",
      "fetch_youtube_transcript",
    ]);

    const html = tools.find((t) => t.name === "fetch_html")!;
    expect(html.description).toBe("Fetch a website and return its unmodified contents as HTML");
    expect(html.inputSchema.type).toBe("object");
    expect(html.inputSchema.required).toEqual(["url"]);
    expect(Object.keys(html.inputSchema.properties!)).toEqual(["url", "headers", "max_length", "start_index", "proxy"]);

    const youtube = tools.find((t) => t.name === "fetch_youtube_transcript")!;
    expect(youtube.inputSchema.properties).toHaveProperty("lang");
  });

  it("routes tools/call to the matching Fetcher method", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: jest.fn().mockResolvedValueOnce("<html>server hello</html>"),
    });

    const result = await client.callTool({
      name: "fetch_html",
      arguments: { url: "https://example.com" },
    });

    expect(result).toEqual({
      content: [{ type: "text", text: "<html>server hello</html>" }],
      isError: false,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("routes markdown tools/call through turndown", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: jest.fn().mockResolvedValueOnce("<html><body><p>Hello <b>world</b></p></body></html>"),
    });

    const result = await client.callTool({
      name: "fetch_markdown",
      arguments: { url: "https://example.com" },
    });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("**world**");
  });

  it("extracts a YouTube transcript via the direct fetch path", async () => {
    const playerResponse = {
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            {
              baseUrl: "https://www.youtube.com/api/timedtext?v=jNQXAC9IVRw&lang=en",
              name: { simpleText: "English" },
              languageCode: "en",
            },
          ],
        },
      },
    };
    const pageHtml = `<!DOCTYPE html><html><body><script>var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};</script></body></html>`;
    const srv1Xml = `<?xml version="1.0" encoding="utf-8" ?><transcript><text start="1.2" dur="2.16">All right</text></transcript>`;

    mockFetch.mockImplementation(async (url: any) => {
      if (String(url).includes("timedtext")) {
        return { ok: true, text: jest.fn().mockResolvedValueOnce(srv1Xml) };
      }
      return { ok: true, text: jest.fn().mockResolvedValueOnce(pageHtml) };
    });

    const result = await client.callTool({
      name: "fetch_youtube_transcript",
      arguments: { url: "https://www.youtube.com/watch?v=jNQXAC9IVRw" },
    });

    expect(result).toEqual({
      content: [{ type: "text", text: "[Transcript language: en — English]\n\n[0:01] All right" }],
      isError: false,
    });
  });

  it("responds with a JSON-RPC internal error for unknown tools", async () => {
    await expect(client.callTool({ name: "fetch_nope" })).rejects.toMatchObject({
      code: -32603,
      message: "Tool not found: fetch_nope",
    });
  });

  it("responds with a JSON-RPC internal error when payload validation fails", async () => {
    const error: any = await client
      .callTool({ name: "fetch_html", arguments: {} })
      .catch((e) => e);

    expect(error.code).toBe(-32603);
    expect(error.message).toContain("url");
  });
});
