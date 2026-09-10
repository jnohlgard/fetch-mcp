import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, jest, spyOn } from "bun:test";
import { Readability } from "@mozilla/readability";
import dns from "node:dns";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as childProcess from "node:child_process";
import { Fetcher, isPrivateIp } from "./Fetcher";
import * as FetcherModule from "./Fetcher";
import { YouTubeTranscriptPayloadSchema } from "./types";
import { RateLimiter, createFetchRateLimiter } from "./RateLimiter";

const originalFetch = globalThis.fetch;
const mockFetch = jest.fn();
const originalLookup = dns.promises.lookup;

afterAll(() => {
  globalThis.fetch = originalFetch;
  dns.promises.lookup = originalLookup;
});

describe("Fetcher", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    globalThis.fetch = mockFetch as any;
    Fetcher.hasYtDlp = false;
    Fetcher.hasYtDlpAt = Date.now()
    Fetcher.checkTtlMs = 60000
    Fetcher.fetchRateLimiter = createFetchRateLimiter();
    // Default: resolve all hostnames to a public IP so existing tests aren't affected
    dns.promises.lookup = (async () => ({ address: "93.184.216.34", family: 4 })) as any;
  });

  const mockRequest = {
    url: "https://example.com",
    headers: { "Custom-Header": "Value" },
  };

  const mockHtml = `
    <html>
      <head>
        <title>Test Page</title>
        <script>console.log('This should be removed');</script>
        <style>body { color: red; }</style>
      </head>
      <body>
        <h1>Hello World</h1>
        <p>This is a test paragraph.</p>
      </body>
    </html>
  `;

  describe("html", () => {
    it("should return the raw HTML content", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: jest.fn().mockResolvedValueOnce(mockHtml),
      });

      const result = await Fetcher.html(mockRequest);
      expect(result).toEqual({
        content: [{ type: "text", text: mockHtml }],
        isError: false,
      });
    });

    it("should handle errors", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const result = await Fetcher.html(mockRequest);
      expect(result).toEqual({
        content: [
          {
            type: "text",
            text: "Failed to fetch https://example.com: Network error",
          },
        ],
        isError: true,
      });
    });
  });

  describe("json", () => {
    it("should parse and return JSON content", async () => {
      const mockJson = { key: "value" };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: jest.fn().mockResolvedValueOnce(JSON.stringify(mockJson)),
      });

      const result = await Fetcher.json(mockRequest);
      expect(result).toEqual({
        content: [{ type: "text", text: JSON.stringify(mockJson) }],
        isError: false,
      });
    });

    it("returns the original digits for large numbers", async () => {
      const bigNumberBody = '{"big": 9007199254740993}';
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: jest.fn().mockResolvedValueOnce(bigNumberBody),
      });

      const result = await Fetcher.json(mockRequest);
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain("9007199254740993");
    });

    it("still rejects invalid JSON and reports the content-type", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: jest.fn().mockReturnValue("text/html; charset=utf-8") },
        text: jest.fn().mockResolvedValueOnce("<html>not json</html>"),
      });

      const result = await Fetcher.json(mockRequest);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(
        "Failed to fetch https://example.com: response is not valid JSON (content-type: text/html; charset=utf-8)"
      );
    });

    it("still rejects invalid JSON when no content-type header is present", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: jest.fn().mockResolvedValueOnce("not json at all"),
      });

      const result = await Fetcher.json(mockRequest);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(
        "Failed to fetch https://example.com: response is not valid JSON (content-type: unknown)"
      );
    });

    it("should handle errors", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Invalid JSON"));

      const result = await Fetcher.json(mockRequest);
      expect(result).toEqual({
        content: [
          {
            type: "text",
            text: "Failed to fetch https://example.com: Invalid JSON",
          },
        ],
        isError: true,
      });
    });
  });

  describe("txt", () => {
    it("should handle errors", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Parsing error"));

      const result = await Fetcher.txt(mockRequest);
      expect(result).toEqual({
        content: [
          {
            type: "text",
            text: "Failed to fetch https://example.com: Parsing error",
          },
        ],
        isError: true,
      });
    });
  });

  describe("readable", () => {
    const articleHtml = `
      <html>
        <head><title>Test Article</title></head>
        <body>
          <nav>Navigation</nav>
          <article>
            <h1>Hello World</h1>
            <p>This is the main article content that should be extracted by Readability. It needs to be long enough for Readability to consider it real content, so here is some additional text to pad it out a bit more.</p>
          </article>
          <footer>Footer stuff</footer>
        </body>
      </html>
    `;

    it("should return readable content as markdown", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: jest.fn().mockResolvedValueOnce(articleHtml),
      });

      const result = await Fetcher.readable(mockRequest);
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain("Hello World");
    });

    it("should return error when Readability cannot parse", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: jest.fn().mockResolvedValueOnce("<html><body></body></html>"),
      });

      const result = await Fetcher.readable(mockRequest);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Failed to parse readable content");
    });

    it("falls back to whole-page markdown when fallback is 'markdown'", async () => {
      const parseSpy = spyOn(Readability.prototype, "parse").mockReturnValue(null);
      try {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: jest.fn().mockResolvedValueOnce(
            "<html><body><h1>Full page</h1><p>Whole page content.</p></body></html>"
          ),
        });

        const result = await Fetcher.readable({ ...mockRequest, fallback: "markdown" });
        expect(result.isError).toBe(false);
        expect(result.content[0].text).toContain("Full page");
      } finally {
        parseSpy.mockRestore();
      }
    });

    it("falls back to whole-page plain text when fallback is 'txt'", async () => {
      const parseSpy = spyOn(Readability.prototype, "parse").mockReturnValue(null);
      try {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: jest.fn().mockResolvedValueOnce(
            "<html><body><h1>Full page</h1><p>Whole page content.</p></body></html>"
          ),
        });

        const result = await Fetcher.readable({ ...mockRequest, fallback: "txt" });
        expect(result.isError).toBe(false);
        expect(result.content[0].text).toContain("Whole page content.");
      } finally {
        parseSpy.mockRestore();
      }
    });

    it("still errors when Readability cannot parse and fallback is 'none'", async () => {
      const parseSpy = spyOn(Readability.prototype, "parse").mockReturnValue(null);
      try {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: jest.fn().mockResolvedValueOnce(
            "<html><body><p>content</p></body></html>"
          ),
        });

        const result = await Fetcher.readable({ ...mockRequest, fallback: "none" });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("Failed to parse readable content");
      } finally {
        parseSpy.mockRestore();
      }
    });

    it("should handle fetch errors", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const result = await Fetcher.readable(mockRequest);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Failed to fetch https://example.com: Network error");
    });
  });

  describe("markdown", () => {
    it("should handle errors", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Conversion error"));

      const result = await Fetcher.markdown(mockRequest);
      expect(result).toEqual({
        content: [
          {
            type: "text",
            text: "Failed to fetch https://example.com: Conversion error",
          },
        ],
        isError: true,
      });
    });
  });

  describe("JSDOM script execution guard", () => {
    // The marker is built from a concatenation so the literal string "PWNED"
    // never appears in the <script> source itself. If runScripts is ever
    // enabled on JSDOM, the script executes and the marker appears in the
    // rendered text, failing both assertions below.
    const scriptHtml = `
      <html>
        <head><title>Guard Page</title></head>
        <body>
          <article>
            <h1>Guard Article</h1>
            <p>Legitimate article content for the guard check.</p>
          </article>
          <script>document.body.textContent += document.title + "PWN" + "ED"</script>
        </body>
      </html>
    `;

    it("txt does not execute inline scripts", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: jest.fn().mockResolvedValueOnce(scriptHtml),
      });

      const result = await Fetcher.txt(mockRequest);
      expect(result.isError).toBe(false);
      expect(result.content[0].text).not.toContain("PWNED");
    });

    it("readable does not execute inline scripts", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: jest.fn().mockResolvedValueOnce(scriptHtml),
      });

      const result = await Fetcher.readable(mockRequest);
      expect(result.isError).toBe(false);
      expect(result.content[0].text).not.toContain("PWNED");
    });
  });

  describe("concurrency limit", () => {
    // Mocks fetch with a delay and tracks how many mocked requests are in
    // flight at once, so a test can assert the semaphore actually serializes
    // (or doesn't) the outbound calls.
    function slowFetchMock(delayMs: number): () => number {
      let inFlight = 0;
      let maxInFlight = 0;
      mockFetch.mockImplementation(() => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise((resolve) =>
          setTimeout(() => {
            inFlight--;
            resolve({ ok: true, text: jest.fn().mockResolvedValueOnce("body") });
          }, delayMs)
        );
      });
      return () => maxInFlight;
    }

    it("queues the third concurrent fetch when the limit is 1", async () => {
      Fetcher.fetchRateLimiter = new RateLimiter(1);
      const maxInFlight = slowFetchMock(30);

      const results = await Promise.all([
        Fetcher.html({ url: "https://example.com" }),
        Fetcher.html({ url: "https://example.com" }),
        Fetcher.html({ url: "https://example.com" }),
      ]);

      expect(results.every((r) => !r.isError)).toBe(true);
      expect(maxInFlight()).toBe(1);
    });

    it("fires all fetches in parallel when the limit is 0 (unlimited)", async () => {
      Fetcher.fetchRateLimiter = new RateLimiter(0);
      const maxInFlight = slowFetchMock(30);

      const results = await Promise.all([
        Fetcher.html({ url: "https://example.com" }),
        Fetcher.html({ url: "https://example.com" }),
        Fetcher.html({ url: "https://example.com" }),
      ]);

      expect(results.every((r) => !r.isError)).toBe(true);
      expect(maxInFlight()).toBe(3);
    });

    it("builds the limiter from MAX_CONCURRENT_FETCHES", () => {
      process.env.MAX_CONCURRENT_FETCHES = "2";
      try {
        expect(createFetchRateLimiter().limit).toBe(2);
      } finally {
        delete process.env.MAX_CONCURRENT_FETCHES;
      }
    });
  });

  describe("SSRF protection", () => {
    it("should block file:// URLs", async () => {
      const result = await Fetcher.html({ url: "file:///etc/passwd" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('disallowed protocol "file:"');
    });

    it("should block data: URLs", async () => {
      const result = await Fetcher.html({ url: "data:text/html,<h1>hi</h1>" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('disallowed protocol "data:"');
    });

    it("should block ftp: URLs", async () => {
      const result = await Fetcher.html({ url: "ftp://example.com/file" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('disallowed protocol "ftp:"');
    });

    it("should block IPv6 loopback http://[::1]/", async () => {
      const result = await Fetcher.html({ url: "http://[::1]/" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("private address");
    });

    it("should block IPv4-mapped IPv6 addresses in dotted form", async () => {
      const result = await Fetcher.html({ url: "http://[::ffff:127.0.0.1]/" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("private address");
      expect(result.content[0].text).not.toContain("Failed to fetch");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should block IPv4-mapped IPv6 addresses in hex form", async () => {
      const result = await Fetcher.html({ url: "http://[::ffff:7f00:1]/" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("private address");
      expect(result.content[0].text).not.toContain("Failed to fetch");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should block redirects to private IPs", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        url: "http://127.0.0.1/internal",
        text: jest.fn().mockResolvedValueOnce("secret"),
      });

      const result = await Fetcher.html({ url: "https://example.com" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("private address");
      // Should NOT be double-wrapped with "Failed to fetch" prefix
      expect(result.content[0].text).not.toContain("Failed to fetch");
    });

    it("should allow redirects to public URLs", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        url: "https://cdn.example.com/page",
        text: jest.fn().mockResolvedValueOnce("<html>ok</html>"),
      });

      const result = await Fetcher.html({ url: "https://example.com" });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toBe("<html>ok</html>");
    });

    it("validates a redirect target before the hop fires", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 302,
        headers: new Headers({ location: "http://[::ffff:127.0.0.1]/x" }),
        text: jest.fn().mockResolvedValueOnce(""),
      })

      const result = await Fetcher.html({ url: "https://example.com" })
      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain("private address")
      expect(result.content[0].text).not.toContain("Failed to fetch")
    });

    it("follows a public redirect chain and returns the final content", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 302,
          headers: new Headers({ location: "https://b.example.com/one" }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 302,
          headers: new Headers({ location: "https://c.example.com/final" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: jest.fn().mockResolvedValueOnce("final content"),
        })

      const result = await Fetcher.html({ url: "https://example.com/start" })
      const fetchCalls = mockFetch.mock.calls.map((args) => args[0] as string)
      mockFetch.mockReset()
      expect(result.isError).toBe(false)
      expect(result.content[0].text).toBe("final content")
      expect(fetchCalls).toEqual([
        "https://example.com/start",
        "https://b.example.com/one",
        "https://c.example.com/final",
      ])
    });

    it("rejects an endless redirect loop with a bounded error", async () => {
      const cycle = ["https://a.example.com/two", "https://a.example.com/one"]
      for (let i = 0; i < 21; i++) {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 302,
          headers: new Headers({ location: cycle[i % 2] }),
        })
      }

      const result = await Fetcher.html({ url: "https://a.example.com/one" })
      const callCount = mockFetch.mock.calls.length
      mockFetch.mockReset()
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain("too many redirects")
      expect(callCount).toBeLessThanOrEqual(21)
    });

    it("should block CGNAT (100.64.0.0/10) addresses", async () => {
      const result = await Fetcher.html({ url: "http://100.64.0.1/" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("private address");
      expect(result.content[0].text).not.toContain("Failed to fetch");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should block Teredo (2001:20::/28) tunnel addresses", async () => {
      const result = await Fetcher.html({ url: "http://[2001:0020:1234:5678::1]/" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("private address");
      expect(result.content[0].text).not.toContain("Failed to fetch");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should block 6to4 (2002::/16) tunnel addresses", async () => {
      const result = await Fetcher.html({ url: "http://[2002:0a00:0001::1]/" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("private address");
      expect(result.content[0].text).not.toContain("Failed to fetch");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should block NAT64 addresses embedding private IPv4", async () => {
      const result = await Fetcher.html({ url: "http://[64:ff9b::10.0.0.1]/" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("private address");
      expect(result.content[0].text).not.toContain("Failed to fetch");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should allow public IPv4-mapped IPv6 addresses", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: jest.fn().mockResolvedValueOnce("<html>ok</html>"),
      });

      const result = await Fetcher.html({ url: "http://[::ffff:8.8.8.8]/" });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toBe("<html>ok</html>");
    });
  });

  describe("cross-origin redirect credentials", () => {
    it("does not send Authorization on a same-origin-to-cross-origin redirect", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 302,
          headers: new Headers({ location: "https://other.example.com/final" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: jest.fn().mockResolvedValueOnce("<html>ok</html>"),
        });

      await Fetcher.html({
        url: "https://example.com/start",
        headers: { Authorization: "Bearer secret", "X-Keep": "yes" },
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const secondHeaders = mockFetch.mock.calls[1][1].headers as Record<string, string>;
      expect(secondHeaders).not.toHaveProperty("Authorization");
      expect(secondHeaders).not.toHaveProperty("authorization");
      // Non-credential headers still follow the redirect.
      expect(secondHeaders).toHaveProperty("X-Keep", "yes");
    });

    it("keeps Authorization across a same-origin redirect", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 302,
          headers: new Headers({ location: "https://example.com/elsewhere" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: jest.fn().mockResolvedValueOnce("<html>ok</html>"),
        });

      await Fetcher.html({
        url: "https://example.com/start",
        headers: { Authorization: "Bearer secret" },
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const secondHeaders = mockFetch.mock.calls[1][1].headers as Record<string, string>;
      expect(secondHeaders).toHaveProperty("Authorization", "Bearer secret");
    });

    it("keeps Authorization on the initial (non-redirect) request", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: jest.fn().mockResolvedValueOnce("<html>ok</html>"),
      });

      await Fetcher.html({
        url: "https://example.com/start",
        headers: { Authorization: "Bearer secret" },
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const firstHeaders = mockFetch.mock.calls[0][1].headers as Record<string, string>;
      expect(firstHeaders).toHaveProperty("Authorization", "Bearer secret");
    });
  });

  describe("isPrivateIp", () => {
    const blocked = [
      "10.0.0.1",
      "172.16.0.1",
      "192.168.1.1",
      "100.64.0.1",
      "100.127.255.254",
      "198.18.0.1",
      "198.19.255.254",
      "169.254.169.254",
      "127.0.0.1",
      "0.0.0.0",
      "255.255.255.255",
      "192.0.0.1",
      "192.0.2.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "239.255.255.255",
      "::",
      "::1",
      "::10.0.0.1",
      "::ffff:10.0.0.1",
      "::ffff:7f00:1",
      "::ffff:127.0.0.1",
      "64:ff9b::10.0.0.1",
      "64:ff9b::7f00:1",
      "64:ff9b:1::1",
      "ff02::1",
      "fe80::1",
      "fc00::1",
      "fd00::1",
      "100::1",
      "2001:db8::1",
      "2002:1::1",
      "2001:20::1",
      "2001:0020:1234:5678::1",
      "2001:3f::1",
    ];

    const allowed = [
      "8.8.8.8",
      "1.1.1.1",
      "93.184.216.34",
      "192.0.1.1",
      "3ffe::1",
      "2606:4700:4700::1111",
      "2001:4860:4860::8888",
      "::ffff:8.8.8.8",
      "::ffff:808:808",
      "example.com",
      "not.an.ip.com",
      "",
    ];

    it("blocks private, special-use, and tunneling addresses", () => {
      for (const ip of blocked) {
        expect(isPrivateIp(ip), `${ip} should be blocked`).toBe(true);
      }
    });

    it("allows global unicast addresses and non-IP input", () => {
      for (const ip of allowed) {
        expect(isPrivateIp(ip), `${ip} should be allowed`).toBe(false);
      }
    });
  });

  describe("proxy", () => {
    it("should pass proxy option to fetch when provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: jest.fn().mockResolvedValueOnce("<html>ok</html>"),
      });

      await Fetcher.html({ url: "https://example.com", proxy: "http://proxy:8080" });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[1]).toHaveProperty("proxy", "http://proxy:8080");
    });

    it("should not include proxy option when not provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: jest.fn().mockResolvedValueOnce("<html>ok</html>"),
      });

      await Fetcher.html({ url: "https://example.com" });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[1]).not.toHaveProperty("proxy");
    });
  });

  describe("fetch timeout", () => {
    // A mock fetch that hangs until its AbortSignal fires, then rejects with an
    // AbortError — this mirrors real fetch/undici behavior so the AbortController
    // path in _fetch is genuinely exercised rather than stubbed away.
    function hangUntilAbort(_url: string, init?: RequestInit): Promise<Response> {
      return new Promise((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }

    it("times out a hung request with a clear error", async () => {
      process.env.FETCH_TIMEOUT_MS = "20";
      try {
        mockFetch.mockImplementationOnce(hangUntilAbort);
        const result = await Fetcher.html({ url: "https://example.com" });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toBe(
          "Failed to fetch https://example.com: timed out after 20ms",
        );
      } finally {
        delete process.env.FETCH_TIMEOUT_MS;
      }
    });

    it("completes a fast request before the timeout fires", async () => {
      process.env.FETCH_TIMEOUT_MS = "50";
      try {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: jest.fn().mockResolvedValueOnce("<html>quick</html>"),
        });
        const result = await Fetcher.html({ url: "https://example.com" });
        expect(result.isError).toBe(false);
        expect(result.content[0].text).toBe("<html>quick</html>");
      } finally {
        delete process.env.FETCH_TIMEOUT_MS;
      }
    });

    it("gives each redirect hop a fresh timeout budget", async () => {
      process.env.FETCH_TIMEOUT_MS = "20";
      try {
        // First hop redirects (its timer is cleared on completion); the second
        // hop hangs and hits its own, fresh 20ms budget.
        mockFetch
          .mockResolvedValueOnce({
            ok: false,
            status: 302,
            headers: new Headers({ location: "https://b.example.com/next" }),
          })
          .mockImplementationOnce(hangUntilAbort);
        const result = await Fetcher.html({ url: "https://example.com/start" });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("timed out after 20ms");
        expect(mockFetch).toHaveBeenCalledTimes(2);
      } finally {
        delete process.env.FETCH_TIMEOUT_MS;
      }
    });
  });

  describe("youtubeTranscript", () => {
    it("should fetch and parse YouTube transcript", async () => {
      const playerResponse = {
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [
              {
                languageCode: "en",
                baseUrl: "https://www.youtube.com/api/timedtext?lang=en",
                name: { simpleText: "English" },
              },
            ],
          },
        },
      };
      const pageHtml = `<html><script>var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};</script></html>`;
      const captionXml = `<transcript><text start="0" dur="2">Hello</text><text start="2" dur="3">World</text></transcript>`;

      // First call: page HTML. Second call: caption XML.
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          text: jest.fn().mockResolvedValueOnce(pageHtml),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: jest.fn().mockResolvedValueOnce(captionXml),
        });

      const result = await Fetcher.youtubeTranscript({
        url: "https://www.youtube.com/watch?v=test",
      });

      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain("[Transcript language: en");
      expect(result.content[0].text).toContain("[0:00] Hello");
      expect(result.content[0].text).toContain("[0:02] World");
    });

    it("should pass proxy when fetching captions", async () => {
      const playerResponse = {
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [
              {
                languageCode: "en",
                baseUrl: "https://www.youtube.com/api/timedtext?lang=en",
                name: { simpleText: "English" },
              },
            ],
          },
        },
      };
      const pageHtml = `<html><script>var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};</script></html>`;
      const captionXml = `<transcript><text start="0" dur="2">Hi</text></transcript>`;

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          text: jest.fn().mockResolvedValueOnce(pageHtml),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: jest.fn().mockResolvedValueOnce(captionXml),
        });

      await Fetcher.youtubeTranscript({
        url: "https://www.youtube.com/watch?v=test",
        proxy: "http://proxy:8080",
      });

      // Both calls should include proxy
      for (const call of mockFetch.mock.calls) {
        expect(call[1]).toHaveProperty("proxy", "http://proxy:8080");
      }
    });

    it("should return error when no captions found", async () => {
      const pageHtml = `<html><script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"test"}};</script></html>`;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: jest.fn().mockResolvedValueOnce(pageHtml),
      });

      const result = await Fetcher.youtubeTranscript({
        url: "https://www.youtube.com/watch?v=test",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("No caption tracks found");
    });

    it("appends ?fmt=srv1 when the base URL has no query string", async () => {
      const playerResponse = {
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [
              {
                languageCode: "en",
                baseUrl: "https://www.youtube.com/api/timedtext",
                name: { simpleText: "English" },
              },
            ],
          },
        },
      };
      const pageHtml = `<html><script>var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};</script></html>`;
      const captionXml = `<transcript><p t="1234" d="250">hello</p></transcript>`;

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          text: jest.fn().mockResolvedValueOnce(pageHtml),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: jest.fn().mockResolvedValueOnce(captionXml),
        });

      const result = await Fetcher.youtubeTranscript({
        url: "https://www.youtube.com/watch?v=test",
      });

      expect(result.isError).toBe(false);
      const captionUrl = mockFetch.mock.calls[1][0] as string;
      expect(captionUrl.split("?").length - 1).toBe(1);
      expect(new URL(captionUrl).searchParams.get("fmt")).toBe("srv1");
    });

    it("does not get confused by a fmt= substring elsewhere", async () => {
      const playerResponse = {
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [
              {
                languageCode: "en",
                baseUrl: "https://example.com/api/timedtext?lang=en&filter=fmt=x",
                name: { simpleText: "English" },
              },
            ],
          },
        },
      };
      const pageHtml = `<html><script>var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};</script></html>`;
      const captionXml = `<transcript><p t="1234" d="250">hello</p></transcript>`;

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          text: jest.fn().mockResolvedValueOnce(pageHtml),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: jest.fn().mockResolvedValueOnce(captionXml),
        });

      const result = await Fetcher.youtubeTranscript({
        url: "https://www.youtube.com/watch?v=test",
      });

      expect(result.isError).toBe(false);
      const captionUrl = mockFetch.mock.calls[1][0] as string;
      expect(new URL(captionUrl).searchParams.get("fmt")).toBe("srv1");
    });

    it("returns an error when no captions parse", async () => {
      const playerResponse = {
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [
              {
                languageCode: "en",
                baseUrl: "https://www.youtube.com/api/timedtext?lang=en",
                name: { simpleText: "English" },
              },
            ],
          },
        },
      };
      const pageHtml = `<html><script>var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};</script></html>`;
      const captionXml = `<transcript></transcript>`;

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          text: jest.fn().mockResolvedValueOnce(pageHtml),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: jest.fn().mockResolvedValueOnce(captionXml),
        });

      const result = await Fetcher.youtubeTranscript({
        url: "https://www.youtube.com/watch?v=test",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("No transcript captions were found");
    });
  });

  describe("youtubeTranscript URL validation", () => {
    const nonHttpUrls = [
      "file:///etc/passwd",
      "ftp://example.com/file",
      "rtmp://example.com/live",
    ];
    let execFileSyncSpy: ReturnType<typeof spyOn>;

    beforeAll(() => {
      execFileSyncSpy = spyOn(childProcess, "execFileSync");
    });

    beforeEach(() => {
      execFileSyncSpy.mockClear();
    });

    afterAll(() => {
      execFileSyncSpy.mockRestore();
    });

    it("never spawns yt-dlp for non-http(s) URLs", async () => {
      for (const url of nonHttpUrls) {
        Fetcher.hasYtDlp = true;

        const result = await Fetcher.youtubeTranscript({ url });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("disallowed protocol");
        expect(execFileSyncSpy).not.toHaveBeenCalled();
      }
    });

    it("zod schema rejects non-http(s) URLs", () => {
      for (const url of nonHttpUrls) {
        expect(YouTubeTranscriptPayloadSchema.safeParse({ url }).success).toBe(false);
      }
      expect(
        YouTubeTranscriptPayloadSchema.safeParse({
          url: "https://www.youtube.com/watch?v=abc123",
        }).success,
      ).toBe(true);
    });
  });

  describe("DNS rebinding SSRF protection", () => {
    it("should block hostnames that resolve to private IPs", async () => {
      const lookupSpy = spyOn(dns.promises, "lookup").mockResolvedValueOnce({
        address: "127.0.0.1",
        family: 4,
      } as any);

      const result = await Fetcher.html({ url: "https://evil.example.com" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("resolved to private IP");
      expect(result.content[0].text).toContain("DNS rebinding");
      lookupSpy.mockRestore();
    });

    it("should block post-redirect hostnames that resolve to private IPs", async () => {
      const lookupSpy = spyOn(dns.promises, "lookup")
        .mockResolvedValueOnce({ address: "93.184.216.34", family: 4 } as any) // pre-fetch: public
        .mockResolvedValueOnce({ address: "10.0.0.1", family: 4 } as any); // post-redirect: private

      mockFetch.mockResolvedValueOnce({
        ok: true,
        url: "https://internal.evil.com/secret",
        text: jest.fn().mockResolvedValueOnce("secret data"),
      });

      const result = await Fetcher.html({ url: "https://example.com" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("resolved to private IP");
      lookupSpy.mockRestore();
    });

    it("should allow hostnames that resolve to public IPs", async () => {
      const lookupSpy = spyOn(dns.promises, "lookup").mockResolvedValueOnce({
        address: "93.184.216.34",
        family: 4,
      } as any);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: jest.fn().mockResolvedValueOnce("<html>ok</html>"),
      });

      const result = await Fetcher.html({ url: "https://example.com" });
      expect(result.isError).toBe(false);
      lookupSpy.mockRestore();
    });

    it("should block hostnames that resolve to CGNAT addresses", async () => {
      const lookupSpy = spyOn(dns.promises, "lookup").mockResolvedValueOnce({
        address: "100.64.0.1",
        family: 4,
      } as any);

      const result = await Fetcher.html({ url: "https://evil.example.com" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("resolved to private IP");
      lookupSpy.mockRestore();
    });
  });

  describe("yt-dlp lang sanitization", () => {
    const flagLikeLangs = ["-o", "--sub-format", "--skip-download"];
    let execFileSyncSpy: ReturnType<typeof spyOn>;

    beforeAll(() => {
      execFileSyncSpy = spyOn(childProcess, "execFileSync");
    });

    beforeEach(() => {
      execFileSyncSpy.mockClear();
    });

    afterAll(() => {
      execFileSyncSpy.mockRestore();
    });

    it("rejects flag-like lang values without invoking yt-dlp", async () => {
      for (const lang of flagLikeLangs) {
        Fetcher.hasYtDlp = true;

        const result = await Fetcher.youtubeTranscript({
          url: "https://www.youtube.com/watch?v=abc123",
          lang,
        });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("Invalid language code");
        expect(execFileSyncSpy).not.toHaveBeenCalled();
      }
    });

    it("passes BCP-47 codes like es-419 and zh-Hans through validation", async () => {
      for (const lang of ["es-419", "zh-Hans"]) {
        Fetcher.hasYtDlp = true;
        execFileSyncSpy.mockImplementationOnce(() => {
          throw new Error("yt-dlp failed");
        });
        mockFetch.mockRejectedValueOnce(new Error("Network error"));

        const result = await Fetcher.youtubeTranscript({
          url: "https://www.youtube.com/watch?v=abc123",
          lang,
        });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).not.toContain("Invalid language code");
        expect(execFileSyncSpy).toHaveBeenCalled();
      }
    });

    it("should reject lang with shell metacharacters", async () => {
      Fetcher.hasYtDlp = true;

      const result = await Fetcher.youtubeTranscript({
        url: "https://www.youtube.com/watch?v=test",
        lang: "en; rm -rf /",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Invalid language code");
    });

    it("should reject lang with command substitution", async () => {
      Fetcher.hasYtDlp = true;

      const result = await Fetcher.youtubeTranscript({
        url: "https://www.youtube.com/watch?v=test",
        lang: "$(whoami)",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Invalid language code");
    });

    it("should accept valid language codes", async () => {
      Fetcher.hasYtDlp = true;
      // This will fail at yt-dlp execution (not installed in test), falling back to direct fetch
      // which will also fail since we haven't mocked fetch — but it should NOT fail at lang validation
      const lookupSpy = spyOn(dns.promises, "lookup").mockResolvedValue({
        address: "93.184.216.34",
        family: 4,
      } as any);

      const playerResponse = {
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [{ languageCode: "pt-BR", baseUrl: "https://youtube.com/api/timedtext?lang=pt-BR", name: { simpleText: "Portuguese" } }],
          },
        },
      };
      const pageHtml = `<html><script>var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};</script></html>`;
      const captionXml = `<transcript><text start="0" dur="2">Olá</text></transcript>`;

      mockFetch
        .mockResolvedValueOnce({ ok: true, text: jest.fn().mockResolvedValueOnce(pageHtml) })
        .mockResolvedValueOnce({ ok: true, text: jest.fn().mockResolvedValueOnce(captionXml) });

      const result = await Fetcher.youtubeTranscript({
        url: "https://www.youtube.com/watch?v=test",
        lang: "pt-BR",
      });
      expect(result.isError).toBe(false);
      lookupSpy.mockRestore();
    });

    it("should accept language codes with digits like es-419", async () => {
      Fetcher.hasYtDlp = true;
      const lookupSpy = spyOn(dns.promises, "lookup").mockResolvedValue({
        address: "93.184.216.34",
        family: 4,
      } as any);

      const playerResponse = {
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [{ languageCode: "es-419", baseUrl: "https://youtube.com/api/timedtext?lang=es-419", name: { simpleText: "Spanish (Latin America)" } }],
          },
        },
      };
      const pageHtml = `<html><script>var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};</script></html>`;
      const captionXml = `<transcript><text start="0" dur="2">Hola</text></transcript>`;

      mockFetch
        .mockResolvedValueOnce({ ok: true, text: jest.fn().mockResolvedValueOnce(pageHtml) })
        .mockResolvedValueOnce({ ok: true, text: jest.fn().mockResolvedValueOnce(captionXml) });

      const result = await Fetcher.youtubeTranscript({
        url: "https://www.youtube.com/watch?v=test",
        lang: "es-419",
      });
      expect(result.isError).toBe(false);
      lookupSpy.mockRestore();
    });
  });

  describe("yt-dlp portability", () => {
    const originalStderrWrite = process.stderr.write;
    let stderrLines: string[] = [];
    let execFileSyncSpy: ReturnType<typeof spyOn>;

    const srv1 = '<p t="1234" d="250">hello</p>';

    beforeAll(() => {
      execFileSyncSpy = spyOn(childProcess, "execFileSync").mockImplementation(
        (_file: string, args: string[] = []) => {
          const outIndex = args.indexOf("-o");
          const outputTemplate = args[outIndex + 1];
          const dir = path.dirname(outputTemplate);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(`${dir}/sub.en.srv1`, srv1, "utf-8");
          return "";
        },
      );
    });

    beforeEach(() => {
      execFileSyncSpy.mockClear();
      stderrLines = [];
      process.stderr.write = ((s: string) => {
        for (const line of s.split("\n")) {
          if (line.length > 0) stderrLines.push(line);
        }
        return true;
      }) as any;
    });

    afterAll(() => {
      execFileSyncSpy.mockRestore();
      process.stderr.write = originalStderrWrite;
    });

    it("produces the transcript when yt-dlp succeeds", async () => {
      Fetcher.hasYtDlp = true;

      const result = await Fetcher.youtubeTranscript({
        url: "https://www.youtube.com/watch?v=abc123",
      });

      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain("hello");
    });

    it("reports on stderr when yt-dlp fails and it falls back to direct extraction", async () => {
      Fetcher.hasYtDlp = true;
      execFileSyncSpy.mockImplementation(() => {
        throw new Error("boom: yt-dlp crashed");
      });

      const playerResponse = {
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [{ languageCode: "en", baseUrl: "https://youtube.com/api/timedtext?lang=en", name: { simpleText: "English" } }],
          },
        },
      };
      const pageHtml = `<html><script>var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};</script></html>`;
      const captionXml = `<transcript><text start="0" dur="2">Fallback line</text></transcript>`;
      mockFetch
        .mockResolvedValueOnce({ ok: true, text: jest.fn().mockResolvedValueOnce(pageHtml) })
        .mockResolvedValueOnce({ ok: true, text: jest.fn().mockResolvedValueOnce(captionXml) });

      const result = await Fetcher.youtubeTranscript({
        url: "https://www.youtube.com/watch?v=abc123",
      });

      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain("Fallback line");
      expect(stderrLines).toHaveLength(1);
      expect(stderrLines[0]).toContain("yt-dlp");
      expect(stderrLines[0]).toMatch(/falling back to direct transcript extraction/i);
    });
  });

  describe("checkYtDlp", () => {
    const originalPath = process.env.PATH
    let emptyDir: string
    let withYtDlpDir: string

    beforeAll(() => {
      emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "fetch-mcp-probe-empty-"))
      withYtDlpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fetch-mcp-probe-which-"))
      fs.writeFileSync(path.join(withYtDlpDir, "yt-dlp"), "#!/bin/sh\necho yt-dlp\n", "utf-8")
      fs.chmodSync(path.join(withYtDlpDir, "yt-dlp"), 0o755)
    })

    afterEach(() => {
      process.env.PATH = originalPath
    })

    afterAll(() => {
      fs.rmSync(emptyDir, { recursive: true, force: true })
      fs.rmSync(withYtDlpDir, { recursive: true, force: true })
    })

    const clearCache = () => {
      Fetcher.hasYtDlp = null
      Fetcher.hasYtDlpAt = 0
      Fetcher.checkTtlMs = 0
    }

    it("should return a promise (async)", async () => {
      clearCache()
      const result = Fetcher.checkYtDlp()
      expect(result).toBeInstanceOf(Promise)
      await result
    })

    it("should return cached value when already checked", async () => {
      Fetcher.hasYtDlp = true
      const result = await Fetcher.checkYtDlp()
      expect(result).toBe(true)
    })

    it("rechecks once the cached answer is stale", async () => {
      process.env.PATH = emptyDir
      clearCache()
      const first = await Fetcher.checkYtDlp()
      process.env.PATH = `${withYtDlpDir}${path.delimiter}${originalPath ?? ""}`
      const second = await Fetcher.checkYtDlp()
      expect(first).toBe(false)
      expect(second).toBe(true)
    })

    it("finds yt-dlp on PATH without spawning any process", async () => {
      const execSyncSpy = spyOn(childProcess, "execSync")
      const execSpy = spyOn(childProcess, "exec")
      const spawnSpy = spyOn(childProcess, "spawn")
      process.env.PATH = `${withYtDlpDir}${path.delimiter}${originalPath ?? ""}`
      clearCache()

      const result = await Fetcher.checkYtDlp()

      expect(result).toBe(true)
      expect(execSyncSpy).not.toHaveBeenCalled()
      expect(execSpy).not.toHaveBeenCalled()
      expect(spawnSpy).not.toHaveBeenCalled()
      execSyncSpy.mockRestore()
      execSpy.mockRestore()
      spawnSpy.mockRestore()
    })

    it("returns false when yt-dlp is not on PATH", async () => {
      process.env.PATH = emptyDir
      clearCache()
      const result = await Fetcher.checkYtDlp()
      expect(result).toBe(false)
    })

    it("does not probe while the cache is fresh", async () => {
      const execSyncSpy = spyOn(childProcess, "execSync")
      const execSpy = spyOn(childProcess, "exec")
      const spawnSpy = spyOn(childProcess, "spawn")
      Fetcher.hasYtDlp = true
      Fetcher.hasYtDlpAt = Date.now()
      Fetcher.checkTtlMs = 60000

      const result = await Fetcher.checkYtDlp()

      expect(result).toBe(true)
      expect(execSyncSpy).not.toHaveBeenCalled()
      expect(execSpy).not.toHaveBeenCalled()
      expect(spawnSpy).not.toHaveBeenCalled()
      execSyncSpy.mockRestore()
      execSpy.mockRestore()
      spawnSpy.mockRestore()
    })
  });

  describe("response size limit", () => {
    it("should reject responses with Content-Length exceeding limit", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: (h: string) => h === "content-length" ? "999999999999" : null },
        text: jest.fn().mockResolvedValueOnce("data"),
      });

      const result = await Fetcher.html(mockRequest);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Response too large");
    });

    it("should allow responses within size limit", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: (h: string) => h === "content-length" ? "100" : null },
        text: jest.fn().mockResolvedValueOnce("<html>ok</html>"),
      });

      const result = await Fetcher.html(mockRequest);
      expect(result.isError).toBe(false);
    });
  });

  describe("error handling", () => {
    it("should handle non-OK responses", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const result = await Fetcher.html(mockRequest);
      expect(result).toEqual({
        content: [
          {
            type: "text",
            text: "Failed to fetch https://example.com: HTTP error: 404",
          },
        ],
        isError: true,
      });
    });

    it("should handle unknown errors", async () => {
      mockFetch.mockRejectedValueOnce("Unknown error");

      const result = await Fetcher.html(mockRequest);
      expect(result).toEqual({
        content: [
          {
            type: "text",
            text: "Failed to fetch https://example.com: Unknown error",
          },
        ],
        isError: true,
      });
    });

    it("should produce a string text field when response processing throws a non-Error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: jest.fn().mockRejectedValueOnce("string error"),
      });

      const result = await Fetcher.html(mockRequest);
      expect(result.isError).toBe(true);
      expect(typeof result.content[0].text).toBe("string");
      expect(result.content[0].text).toBe("string error");
    });
  });

  describe("surrogate safety", () => {
    const body = "abc🙂def";

    const hasLoneSurrogate = (text: string) =>
      Array.from(text).some((ch) => {
        const code = ch.codePointAt(0) ?? 0;
        return code >= 0xd800 && code <= 0xdfff
      });

    it("does not split an emoji when max_length ends mid-pair", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: jest.fn().mockResolvedValueOnce(body),
      });

      const result = await Fetcher.html({ url: "https://example.com", max_length: 4 });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toBe(Array.from(body).slice(0, 4).join(""));
      expect(hasLoneSurrogate(result.content[0].text)).toBe(false);
    });

    it("does not split an emoji when start_index begins mid-pair", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: jest.fn().mockResolvedValueOnce(body),
      });

      const result = await Fetcher.html({
        url: "https://example.com",
        max_length: 0,
        start_index: 4,
      });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toBe(Array.from(body).slice(4).join(""));
      expect(hasLoneSurrogate(result.content[0].text)).toBe(false);
    });
  });
});
