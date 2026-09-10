import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { Readability } from "@mozilla/readability";
import is_ip_private from "private-ip";
import dns from "node:dns";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RequestPayload, YouTubeTranscriptPayload, downloadLimit, maxResponseBytes } from "./types.js";
import { YouTubeTranscript } from "./YouTubeTranscript.js";

// The `private-ip` package only understands dotted-quad IPv4 and full IPv6 forms,
// so it misses IPv4-mapped IPv6 addresses such as `::ffff:127.0.0.1` (dotted)
// and `::ffff:7f00:1` (two 16-bit hex groups). This helper expands the
// 32-bit IPv4 payload embedded in a mapped address so it can be checked.
export function toIpv4IfMapped(hostname: string): string {
  if (!hostname.toLowerCase().startsWith("::ffff:")) {
    return hostname;
  }
  const rest = hostname.slice("::ffff:".length).toLowerCase();
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(rest)) {
    return rest;
  }
  const parts = rest.split(":");
  if (parts.length === 2 && parts.every((part) => /^[0-9a-f]+$/.test(part))) {
    const hi = parseInt(parts[0], 16);
    const lo = parseInt(parts[1], 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return hostname;
}

export class Fetcher {
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

  private static validateUrl(url: string): void {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(
        `Fetcher blocked URL with disallowed protocol "${parsedUrl.protocol}". Only HTTP and HTTPS are allowed.`,
      );
    }
    const hostname = parsedUrl.hostname;
    const bareHostname = hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;
    const target = toIpv4IfMapped(bareHostname);
    if (target === 'localhost' || is_ip_private(target)) {
      throw new Error(
        `Fetcher blocked request to private address "${target}". This prevents SSRF attacks where a local MCP server could access privileged internal services.`,
      );
    }
  }

  private static async validateResolvedIp(url: string): Promise<void> {
    const hostname = new URL(url).hostname;
    const bareHostname = hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;
    try {
      const { address } = await dns.promises.lookup(bareHostname);
      const resolved = toIpv4IfMapped(address);
      if (is_ip_private(resolved)) {
        throw new Error(
          `Fetcher blocked request: hostname "${bareHostname}" resolved to private IP "${resolved}". This prevents DNS rebinding SSRF attacks.`,
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
  }: RequestPayload): Promise<Response> {
    const maxRedirectHops = 20;
    let currentUrl = url;
    let hopCount = 0;
    let response: Response;

    for (;;) {
      this.validateUrl(currentUrl);
      await this.validateResolvedIp(currentUrl);

      let fetched: Response
      try {
        fetched = await fetch(currentUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            ...headers,
          },
          redirect: "manual",
          // Note: proxy is a Bun-specific fetch option. On Node.js, this option is silently ignored.
          // To use a proxy on Node.js, you would need an HTTP agent library like http-proxy-agent.
          ...(proxy ? { proxy } : {}),
        } as RequestInit);
      } catch (e: unknown) {
        if (e instanceof Error) {
          throw new Error(`Failed to fetch ${currentUrl}: ${e.message}`);
        }
        throw new Error(`Failed to fetch ${currentUrl}: Unknown error`);
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
        currentUrl = new URL(location, currentUrl).toString()
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
      throw new Error(`Failed to fetch ${url}: HTTP error: ${response.status}`);
    }

    const contentLength = response.headers?.get?.("content-length");
    if (contentLength && parseInt(contentLength, 10) > maxResponseBytes) {
      throw new Error(`Response too large: ${contentLength} bytes exceeds ${maxResponseBytes} byte limit`);
    }

    return response;
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
      reader.cancel();
    }
  }

  static async html(requestPayload: RequestPayload) {
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
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  }

  static async json(requestPayload: RequestPayload) {
    try {
      const response = await this._fetch(requestPayload);
      const text = await this.readResponseText(response);
      JSON.parse(text);
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
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  }

  static async txt(requestPayload: RequestPayload) {
    try {
      const response = await this._fetch(requestPayload);
      const html = await this.readResponseText(response);

      const dom = new JSDOM(html);
      const document = dom.window.document;

      const scripts = document.getElementsByTagName("script");
      const styles = document.getElementsByTagName("style");
      Array.from(scripts).forEach((script) => script.remove());
      Array.from(styles).forEach((style) => style.remove());

      const text = document.body.textContent || "";
      let normalizedText = text.replace(/\s+/g, " ").trim();
      
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
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
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
      const { readdirSync, readFileSync, statSync } = await import("fs");
      const files = readdirSync(tmpDir).filter((f: string) => f.endsWith(".srv1"));
      if (files.length === 0) {
        throw new Error("yt-dlp did not produce subtitle files");
      }
      const file = files[0];
      const filePath = `${tmpDir}/${file}`;
      const size = statSync(filePath).size;
      if (size > maxResponseBytes) {
        throw new Error(`Subtitle file too large: ${size} bytes exceeds ${maxResponseBytes} byte limit`);
      }
      const xml = readFileSync(filePath, "utf-8");
      const matchedLang = file.match(/\.([^.]+)\.srv1$/)?.[1] ?? lang;
      return { xml, lang: matchedLang, langName: matchedLang };
    } finally {
      const { rmSync } = await import("fs");
      rmSync(tmpDir, { recursive: true, force: true });
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
      tracks.find((t: any) => t.languageCode === lang) ?? tracks[0];

    const captionUrl = new URL(track.baseUrl);
    captionUrl.searchParams.set("fmt", "srv1");
    const captionResponse = await this._fetch({
      url: captionUrl.toString(),
      headers: requestPayload.headers,
      proxy: requestPayload.proxy,
    });

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
      const { execSync } = await import("child_process");
      const probe = process.platform === "win32" ? "where yt-dlp" : "which yt-dlp";
      execSync(probe, { encoding: "utf-8", stdio: "pipe" });
      this.hasYtDlp = true;
    } catch {
      this.hasYtDlp = false;
    }
    this.hasYtDlpAt = Date.now()
    return this.hasYtDlp;
  }

  static async youtubeTranscript(requestPayload: YouTubeTranscriptPayload) {
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
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  }

  static async readable(requestPayload: RequestPayload) {
    try {
      const response = await this._fetch(requestPayload);
      const html = await this.readResponseText(response);

      const dom = new JSDOM(html, { url: requestPayload.url });
      const reader = new Readability(dom.window.document);
      const article = reader.parse();

      if (!article) {
        throw new Error("Failed to parse readable content from the page");
      }

      const turndownService = new TurndownService();
      let content = turndownService.turndown(article.content ?? "");

      content = this.applyLengthLimits(
        content,
        requestPayload.max_length ?? downloadLimit,
        requestPayload.start_index ?? 0
      );

      return { content: [{ type: "text", text: content }], isError: false };
    } catch (error) {
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  }

  static async markdown(requestPayload: RequestPayload) {
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
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  }
}
