export class YouTubeTranscript {
  static extractPlayerResponse(html: string): unknown {
    const match = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
    if (!match) {
      throw new Error("Could not find ytInitialPlayerResponse in page HTML");
    }
    return JSON.parse(match[1]);
  }

  static getCaptionTracks(playerResponse: any): any[] {
    const tracks =
      playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!Array.isArray(tracks) || tracks.length === 0) {
      throw new Error("No caption tracks found for this video");
    }
    return tracks;
  }

  static decodeHtmlEntities(text: string): string {
    return text
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
      .replace(
        /&#x([0-9a-fA-F]+);/g,
        (_match, code: string) => String.fromCodePoint(parseInt(code, 16)),
      );
  }

  static parseTranscriptXml(xml: string): string[] {
    const lines: string[] = [];

    // Format 1: <text start="X" dur="Y">content</text>
    const textRegex = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
    // Format 2: <p t="X" d="Y">content</p>
    const pRegex = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;

    let match: RegExpExecArray | null;

    match = textRegex.exec(xml);
    if (match) {
      // Reset and use format 1
      textRegex.lastIndex = 0;
      while ((match = textRegex.exec(xml)) !== null) {
        const startAttr = match[1].match(/\bstart="([^"]+)"/);
        if (!startAttr) {
          continue;
        }
        const seconds = parseFloat(startAttr[1]);
        const content = this.decodeHtmlEntities(match[2].replace(/<[^>]+>/g, "").trim());
        if (content) {
          lines.push(`[${this.formatTimestamp(seconds)}] ${content}`);
        }
      }
    } else {
      // Try format 2
      while ((match = pRegex.exec(xml)) !== null) {
        const tAttr = match[1].match(/\bt="(\d+)"/);
        if (!tAttr) {
          continue;
        }
        const ms = parseInt(tAttr[1], 10);
        const seconds = ms / 1000;
        const content = this.decodeHtmlEntities(match[2].replace(/<[^>]+>/g, "").trim());
        if (content) {
          lines.push(`[${this.formatTimestamp(seconds)}] ${content}`);
        }
      }
    }

    return lines;
  }

  private static formatTimestamp(totalSeconds: number): string {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.floor(totalSeconds % 60);
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  }
}
