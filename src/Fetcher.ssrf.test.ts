import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import http from "node:http";
import { Fetcher } from "./Fetcher";

// Integration test: real (unmocked) fetch against a real loopback server.
// Proves that mapped-IPv6 SSRF is blocked before any request leaves the process.

describe("SSRF: mapped IPv6 end-to-end", () => {
  let server: http.Server;
  let port: number;
  let requests = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      requests += 1;
      res.end("private");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("never connects for a mapped IPv6 loopback URL in dotted form", async () => {
    requests = 0;
    const result = await Fetcher.html({ url: `http://[::ffff:127.0.0.1]:${port}/` });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("private address");
    expect(requests).toBe(0);
  });

  it("never connects for a mapped IPv6 loopback URL in hex form", async () => {
    requests = 0;
    const result = await Fetcher.html({ url: `http://[::ffff:7f00:1]:${port}/` });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("private address");
    expect(requests).toBe(0);
  });
});
