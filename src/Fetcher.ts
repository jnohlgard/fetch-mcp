import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { Readability } from "@mozilla/readability";
import { Address4, Address6 } from "ip-address";
import dns from "node:dns";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RequestPayload, ReadablePayload, YouTubeTranscriptPayload, TextToolResult, downloadLimit, maxResponseBytes } from "./types.js";
import { YouTubeTranscript } from "./YouTubeTranscript.js";
import { RateLimiter, createFetchRateLimiter } from "./RateLimiter.js";

// Allowlist-style SSRF check: only IANA "global unicast" addresses pass.
// ip-address classifies private, loopback, link-local, CGNAT, documentation,
// benchmarking, reserved, unspecified, and multicast ranges, and unwraps
// IPv4-mapped IPv6, so `::ffff:7f00:1` reads as loopback. Teredo addresses
// are global per IANA but embed an attacker-controlled IPv4 address, so the
// 2001:20::/28 prefix is blocked explicitly.
const TEREDO_PREFIX_START = 0x20010020000000000000000000000000n;
const TEREDO_PREFIX_END = 0x2001003fffffffffffffffffffffffffn;

export function isPrivateIp(ip: string): boolean {
  if (Address4.isValid(ip)) {
    return !new Address4(ip).isGlobal();
  }
  if (Address6.isValid(ip)) {
    const address = new Address6(ip);
    if (!address.isGlobal()) {
      return true;
    }
    const value = address.bigInt();
    return value >= TEREDO_PREFIX_START && value <= TEREDO_PREFIX_END;
  }
  return false;
}

// Per-request timeout (ms). A hung or slowloris connection must never block a
// fetch indefinitely. FETCH_TIMEOUT_MS overrides the 30s default and is read per
// call (not once at import) so tests and short-lived processes can tune it
// without a restart.
const DEFAULT_FETCH_TIMEOUT_MS = 30000;
// The auxiliary YouTube caption fetch gets its own, shorter budget.
const DEFAULT_CAPTION_TIMEOUT_MS = 10000;

function timeoutFromEnv(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function getFetchTimeoutMs(): number {
  return timeoutFromEnv("FETCH_TIMEOUT_MS", DEFAULT_FETCH_TIMEOUT_MS);
}

function getCaptionTimeoutMs(): number {
  return timeoutFromEnv("FETCH_CAPTION_TIMEOUT_MS", DEFAULT_CAPTION_TIMEOUT_MS);
}

// HTML parsing (jsdom/Readability/Turndown) is synchronous and can burn CPU on
// pathological pages even under the byte-size cap. PARSE_TIMEOUT_MS bounds the
// async-yielding parse paths and produces a clear error at the deadline; a
// worker-based hard kill is a larger change tracked separately.
const DEFAULT_PARSE_TIMEOUT_MS = 10000;

function getParseTimeoutMs(): number {
  return timeoutFromEnv("PARSE_TIMEOUT_MS", DEFAULT_PARSE_TIMEOUT_MS);
}

// Structured per-request logging on stderr (stdout belongs to the MCP
// protocol). On by default so operators can correlate agent behavior with
// cluster egress; FETCH_LOGGING=0 disables it. Read per call like the timeout
// vars.
function isFetchLoggingEnabled(): boolean {
  const raw = process.env.FETCH_LOGGING;
  if (raw === undefined || raw === "") return true;
  const normalized = raw.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false";
}

// Credential-bearing headers that must not follow a request across an origin
// boundary, matching browser/fetch redirect semantics.
const CREDENTIAL_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);

function stripCredentialHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (CREDENTIAL_HEADERS.has(key.toLowerCase())) continue;
    result[key] = value;
  }
  return result;
}

// Shared catch block for the public tool methods: errors never cross the API
// boundary, they come back as an MCP error result with the original message.
function toErrorResult(error: unknown): TextToolResult {
  return {
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

export class Fetcher {
  // Process-wide cap on concurrent outbound fetches, so a burst of parallel
  // tool calls can't turn one process into a scraping burst. Tests can swap
  // in a different limiter, like they do for hasYtDlp.
  static fetchRateLimiter: RateLimiter = createFetchRateLimiter();

  private static applyLengthLimits(text: string, maxLength: number, startIndex: number): string {
    if (startIndex >= text.length) {
      return "";
    }

    const end = maxLength > 0 ? Math.min(startIndex + maxLength, text.length) : text.length;

    const splitsPair = (index: number): boolean => {
      if (index === 0 || index >= text.length) {
        return false;
      }
      const code = text.charCodeAt(index);
      if (code < 0xdc00 || code > 0xdfff) {
        return false;
      }
      const prev = text.charCodeAt(index - 1);
      return prev >= 0xd800 && prev <= 0xdbff;
    };

    if (splitsPair(startIndex) || splitsPair(end)) {
      return Array.from(text).slice(startIndex, end).join("");
    }

    return text.substring(startIndex, end);
  }

  private static bareHostname(hostname: string): string {
    return hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;
  }

  private static validateUrl(url: string): void {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(
        `Fetcher blocked URL with disallowed protocol "${parsedUrl.protocol}". Only HTTP and HTTPS are allowed.`,
      );
    }
    const bareHostname = this.bareHostname(parsedUrl.hostname);
    if (bareHostname === 'localhost' || isPrivateIp(bareHostname)) {
      throw new Error(
        `Fetcher blocked request to private address "${bareHostname}". This prevents SSRF attacks where a local MCP server could access privileged internal services.`,
      );
    }
  }

  private static async validateResolvedIp(url: string): Promise<void> {
    const bareHostname = this.bareHostname(new URL(url).hostname);
    try {
      const { address } = await dns.promises.lookup(bareHostname);
      if (isPrivateIp(address)) {
        throw new Error(
          `Fetcher blocked request: hostname "${bareHostname}" resolved to private IP "${address}". This prevents DNS rebinding SSRF attacks.`,
        );
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('Fetcher blocked')) throw e;
      // DNS lookup failures (e.g. non-resolvable hostnames) are not SSRF — let fetch handle them
    }
  }

  private static async _fetch({
    url,
    headers,
    proxy,
  }: RequestPayload, timeoutMs?: number): Promise<Response> {
    const maxRedirectHops = 20;
    const startedAt = Date.now();
    let currentUrl = url;
    let currentHeaders = headers;
    let hopCount = 0;
    let response: Response;

    for (;;) {
      this.validateUrl(currentUrl);
      await this.validateResolvedIp(currentUrl);

      // Each redirect hop gets its own timeout budget so a hung/slowloris
      // connection can never block a request indefinitely. The chain is
      // separately bounded by maxRedirectHops, so worst-case total wall-clock
      // time is maxRedirectHops times the per-hop timeout.
      const hopTimeoutMs = timeoutMs ?? getFetchTimeoutMs();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), hopTimeoutMs);

      let fetched: Response
      try {
        // Keep at most the configured number of outbound fetches in flight;
        // anything beyond that queues here until a slot frees up.
        await this.fetchRateLimiter.acquire();
        try {
          fetched = await fetch(currentUrl, {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              ...currentHeaders,
            },
            redirect: "manual",
            signal: controller.signal,
            // Note: proxy is a Bun-specific fetch option. On Node.js, this option is silently ignored.
            // To use a proxy on Node.js, you would need an HTTP agent library like http-proxy-agent.
            ...(proxy ? { proxy } : {}),
          } as RequestInit);
        } finally {
          this.fetchRateLimiter.release();
        }
      } catch (e: unknown) {
        if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) {
          throw new Error(`Failed to fetch ${currentUrl}: timed out after ${hopTimeoutMs}ms`, { cause: e });
        }
        if (e instanceof Error) {
          throw new Error(`Failed to fetch ${currentUrl}: ${e.message}`, { cause: e });
        }
        throw new Error(`Failed to fetch ${currentUrl}: Unknown error`, { cause: e });
      } finally {
        clearTimeout(timer);
      }

      if (
        fetched.status === 301 ||
        fetched.status === 302 ||
        fetched.status === 303 ||
        fetched.status === 307 ||
        fetched.status === 308
      ) {
        if (hopCount >= maxRedirectHops) {
          fetched.body?.cancel().catch(() => {})
          throw new Error(
            `Failed to fetch ${url}: too many redirects (exceeded ${maxRedirectHops} hops)`,
          )
        }
        const location = fetched.headers?.get?.("location")
        if (!location) {
          fetched.body?.cancel().catch(() => {})
          throw new Error(`Failed to fetch ${currentUrl}: HTTP error: ${fetched.status}`)
        }
        fetched.body?.cancel().catch(() => {})
        hopCount += 1
        const nextUrl = new URL(location, currentUrl).toString()
        // Mirror fetch/browser redirect semantics: once a hop crosses an origin
        // boundary, drop credential-bearing headers (Authorization, Cookie,
        // Proxy-Authorization) so they are never leaked to a different host.
        // Stripping is one-way - a later hop back to the original origin does
        // not re-add them.
        if (new URL(currentUrl).origin !== new URL(nextUrl).origin) {
          currentHeaders = stripCredentialHeaders(currentHeaders);
        }
        currentUrl = nextUrl
        continue
      }

      response = fetched;
      break;
    }

    if (response.url && response.url !== url) {
      this.validateUrl(response.url);
      await this.validateResolvedIp(response.url);
    }

    if (!response.ok) {
      this.logFetchOutcome(url, response, startedAt);
      throw new Error(`Failed to fetch ${url}: HTTP error: ${response.status}`);
    }

    const contentLength = response.headers?.get?.("content-length");
    if (contentLength && parseInt(contentLength, 10) > maxResponseBytes) {
      this.logFetchOutcome(url, response, startedAt);
      throw new Error(`Response too large: ${contentLength} bytes exceeds ${maxResponseBytes} byte limit`);
    }

    this.logFetchOutcome(url, response, startedAt);
    return response;
  }

  // One structured line per fetch outcome on stderr. Only the host is logged -
  // never the path, query, or headers - so the log can be correlated with
  // cluster egress metrics without leaking credentials. Bytes come from
  // content-length when the server advertises it.
  private static logFetchOutcome(requestUrl: string, response: Response, startedAt: number): void {
    if (!isFetchLoggingEnabled()) return;

    let finalUrl = requestUrl;
    if (response.url) {
      try {
        finalUrl = new URL(response.url).toString();
      } catch {
        // malformed redirect target; fall back to the requested URL
      }
    }
    let host = "unknown";
    try {
      host = new URL(finalUrl).host;
    } catch {
      // validated URLs never reach this; keep "unknown"
    }

    const parts = [`[fetch-mcp] fetch host=${host}`, `ms=${Date.now() - startedAt}`];
    if (typeof response.status === "number") parts.push(`status=${response.status}`);
    const contentLength = response.headers?.get?.("content-length");
    if (contentLength && /^\d+$/.test(contentLength)) parts.push(`bytes=${contentLength}`);
    process.stderr.write(`${parts.join(" ")}\n`);
  }

  private static async readResponseText(response: Response): Promise<string> {
    if (!response.body) return response.text();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let result = "";
    let bytesRead = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesRead += value.byteLength;
        if (bytesRead > maxResponseBytes) {
          throw new Error(`Response too large: exceeded ${maxResponseBytes} byte limit while reading`);
        }
        result += decoder.decode(value, { stream: true });
      }
      result += decoder.decode();
      return result;
    } finally {
      void reader.cancel();
    }
  }

  static async html(requestPayload: RequestPayload): Promise<TextToolResult> {
    try {
      const response = await this._fetch(requestPayload);
      let html = await this.readResponseText(response);
      
      // Apply length limits
      html = this.applyLengthLimits(
        html, 
        requestPayload.max_length ?? downloadLimit,
        requestPayload.start_index ?? 0
      );

      return { content: [{ type: "text", text: html }], isError: false };
    } catch (error) {
      return toErrorResult(error);
    }
  }

  static async json(requestPayload: RequestPayload): Promise<TextToolResult> {
    try {
      const response = await this._fetch(requestPayload);
      const text = await this.readResponseText(response);

      try {
        JSON.parse(text);
      } catch {
        // JSON.parse's own error only points at the first bad character;
        // the content-type usually tells the caller what actually came back
        // (e.g. an HTML error page instead of JSON).
        const contentType = response.headers?.get("content-type") ?? "unknown";
        throw new Error(
          `Failed to fetch ${requestPayload.url}: response is not valid JSON (content-type: ${contentType})`
        );
      }

      let jsonString = text;
      
      // Apply length limits
      jsonString = this.applyLengthLimits(
        jsonString,
        requestPayload.max_length ?? downloadLimit,
        requestPayload.start_index ?? 0
      );

      return {
        content: [{ type: "text", text: jsonString }],
        isError: false,
      };
    } catch (error) {
      return toErrorResult(error);
    }
  }

  // Runs parse work against a deadline. The work runs on a microtask, so fast
  // synchronous parses always win; anything that yields to the event loop
  // (async-yielding parse, or a future async worker) loses to the timer and
  // surfaces a clear error instead of hanging the tool call.
  private static async withParseDeadline<T>(work: () => T | Promise<T>): Promise<T> {
    const timeoutMs = getParseTimeoutMs();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`parsing timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
    });
    try {
      return await Promise.race([Promise.resolve().then(work), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private static htmlToPlainText(html: string): string {
    const dom = new JSDOM(html);
    const document = dom.window.document;

    const scripts = document.getElementsByTagName("script");
    const styles = document.getElementsByTagName("style");
    Array.from(scripts).forEach((script) => script.remove());
    Array.from(styles).forEach((style) => style.remove());

    return (document.body.textContent || "").replace(/\s+/g, " ").trim();
  }

  static async txt(requestPayload: RequestPayload): Promise<TextToolResult> {
    try {
      const response = await this._fetch(requestPayload);
      const html = await this.readResponseText(response);

      let normalizedText = await this.withParseDeadline(() => this.htmlToPlainText(html));
      
      // Apply length limits
      normalizedText = this.applyLengthLimits(
        normalizedText,
        requestPayload.max_length ?? downloadLimit,
        requestPayload.start_index ?? 0
      );

      return {
        content: [{ type: "text", text: normalizedText }],
        isError: false,
      };
    } catch (error) {
      return toErrorResult(error);
    }
  }

  private static async fetchTranscriptViaYtDlp(
    videoUrl: string,
    lang: string,
  ): Promise<{ xml: string; lang: string; langName: string }> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,9}$/.test(lang)) {
      throw new Error(`Invalid language code: "${lang}". Must start with a letter or digit, contain only letters, digits, and hyphens, and be at most 10 characters.`);
    }
    const { execFileSync } = await import("child_process");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fetch-mcp-"));
    try {
      execFileSync(
        "yt-dlp",
        [
          "--write-sub", "--sub-lang", lang,
          "--sub-format", "srv1",
          "--skip-download",
          "-o", `${tmpDir}/sub`,
          videoUrl,
        ],
        { encoding: "utf-8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] },
      );
      const files = fs.readdirSync(tmpDir).filter((f: string) => f.endsWith(".srv1"));
      if (files.length === 0) {
        throw new Error("yt-dlp did not produce subtitle files");
      }
      const file = files[0];
      const filePath = `${tmpDir}/${file}`;
      const size = fs.statSync(filePath).size;
      if (size > maxResponseBytes) {
        throw new Error(`Subtitle file too large: ${size} bytes exceeds ${maxResponseBytes} byte limit`);
      }
      const xml = fs.readFileSync(filePath, "utf-8");
      const matchedLang = file.match(/\.([^.]+)\.srv1$/)?.[1] ?? lang;
      return { xml, lang: matchedLang, langName: matchedLang };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  private static async fetchTranscriptDirect(
    requestPayload: YouTubeTranscriptPayload,
  ): Promise<{ xml: string; lang: string; langName: string }> {
    const response = await this._fetch(requestPayload);
    const html = await this.readResponseText(response);

    const playerResponse = YouTubeTranscript.extractPlayerResponse(html);
    const tracks = YouTubeTranscript.getCaptionTracks(playerResponse);

    const lang = requestPayload.lang ?? "en";
    const track =
      tracks.find((t) => t.languageCode === lang) ?? tracks[0];

    const captionUrl = new URL(track.baseUrl);
    captionUrl.searchParams.set("fmt", "srv1");
    // The caption fetch is a small, auxiliary request, so it gets its own
    // shorter deadline than the initial page fetch above.
    const captionResponse = await this._fetch({
      url: captionUrl.toString(),
      headers: requestPayload.headers,
      proxy: requestPayload.proxy,
    }, getCaptionTimeoutMs());

    const xml = await this.readResponseText(captionResponse);
    return {
      xml,
      lang: track.languageCode,
      langName: track.name?.simpleText ?? "Unknown",
    };
  }

  static hasYtDlp: boolean | null = null;
  static hasYtDlpAt = 0
  static checkTtlMs = 60000

  static async checkYtDlp(): Promise<boolean> {
    if (this.hasYtDlp !== null && Date.now() - this.hasYtDlpAt < this.checkTtlMs) return this.hasYtDlp;
    try {
      const whichModule = await import("which");
      await whichModule.default("yt-dlp");
      this.hasYtDlp = true;
    } catch {
      this.hasYtDlp = false;
    }
    this.hasYtDlpAt = Date.now()
    return this.hasYtDlp;
  }

  static async youtubeTranscript(requestPayload: YouTubeTranscriptPayload): Promise<TextToolResult> {
    try {
      // Validate before anything consumes the URL (yt-dlp spawn, DNS, fetch)
      this.validateUrl(requestPayload.url);
      const lang = requestPayload.lang ?? "en";
      let result: { xml: string; lang: string; langName: string };

      if (await this.checkYtDlp()) {
        // Validate lang before attempting yt-dlp — this is a security check that must not be swallowed
        if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,9}$/.test(lang)) {
          throw new Error(`Invalid language code: "${lang}". Must start with a letter or digit, contain only letters, digits, and hyphens, and be at most 10 characters.`);
        }
        try {
          result = await this.fetchTranscriptViaYtDlp(requestPayload.url, lang);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          const shortReason = reason.replace(/\s+/g, " ").trim().slice(0, 120);
          process.stderr.write(`yt-dlp failed (${shortReason}). Falling back to direct transcript extraction.\n`);
          result = await this.fetchTranscriptDirect(requestPayload);
        }
      } else {
        result = await this.fetchTranscriptDirect(requestPayload);
      }

      const lines = YouTubeTranscript.parseTranscriptXml(result.xml);
      if (lines.length === 0) {
        throw new Error("No transcript captions were found for this video");
      }
      const header = `[Transcript language: ${result.lang} — ${result.langName}]\n\n`;
      let transcript = header + lines.join("\n");

      transcript = this.applyLengthLimits(
        transcript,
        requestPayload.max_length ?? downloadLimit,
        requestPayload.start_index ?? 0,
      );

      return { content: [{ type: "text", text: transcript }], isError: false };
    } catch (error) {
      return toErrorResult(error);
    }
  }

  // Runs the Readability/fallback extraction pipeline. Kept as a seam so
  // callers can run it against a parse deadline (see withParseDeadline).
  private static parseReadable(
    html: string,
    url: string,
    fallback?: "markdown" | "txt" | "none"
  ): string {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (article) {
      return new TurndownService().turndown(article.content ?? "");
    } else if (fallback === "markdown") {
      // No article detected: fall back to the whole page as Markdown.
      return new TurndownService().turndown(html);
    } else if (fallback === "txt") {
      // No article detected: fall back to the whole page as plain text.
      return this.htmlToPlainText(html);
    }
    throw new Error("Failed to parse readable content from the page");
  }

  static async readable(requestPayload: ReadablePayload): Promise<TextToolResult> {
    try {
      const response = await this._fetch(requestPayload);
      const html = await this.readResponseText(response);

      let content = await this.withParseDeadline(() =>
        this.parseReadable(html, requestPayload.url, requestPayload.fallback)
      );

      content = this.applyLengthLimits(
        content,
        requestPayload.max_length ?? downloadLimit,
        requestPayload.start_index ?? 0
      );

      return { content: [{ type: "text", text: content }], isError: false };
    } catch (error) {
      return toErrorResult(error);
    }
  }

  static async markdown(requestPayload: RequestPayload): Promise<TextToolResult> {
    try {
      const response = await this._fetch(requestPayload);
      const html = await this.readResponseText(response);
      const turndownService = new TurndownService();
      let markdown = turndownService.turndown(html);
      
      // Apply length limits
      markdown = this.applyLengthLimits(
        markdown,
        requestPayload.max_length ?? downloadLimit,
        requestPayload.start_index ?? 0
      );

      return { content: [{ type: "text", text: markdown }], isError: false };
    } catch (error) {
      return toErrorResult(error);
    }
  }
}
