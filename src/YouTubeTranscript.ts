interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  name?: { simpleText?: string };
}

interface PlayerResponse {
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrack[];
    };
  };
}

export class YouTubeTranscript {
  static extractPlayerResponse(html: string): PlayerResponse {
    const marker = /ytInitialPlayerResponse\s*=\s*\{/.exec(html)
    if (!marker) {
      throw new Error("Could not find ytInitialPlayerResponse in page HTML")
    }
    const start = marker.index + marker[0].length - 1
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < html.length; i++) {
      const ch = html[i]
      if (inString) {
        if (escaped) {
          escaped = false
        } else if (ch === "\\") {
          escaped = true
        } else if (ch === '"') {
          inString = false
        }
        continue
      }
      if (ch === '"') {
        inString = true
      } else if (ch === "{") {
        depth++
      } else if (ch === "}") {
        depth--
        if (depth === 0) {
          return JSON.parse(html.slice(start, i + 1))
        }
      }
    }
    throw new Error("unbalanced braces in ytInitialPlayerResponse")
  }

  static getCaptionTracks(playerResponse: PlayerResponse): CaptionTrack[] {
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
    // Format 2: <p t="X" d="Y">content</p>
    const formats = [
      {
        regex: /<text\b([^>]*)>([\s\S]*?)<\/text>/g,
        attr: /\bstart="([^"]+)"/,
        toSeconds: (raw: string) => parseFloat(raw),
      },
      {
        regex: /<p\b([^>]*)>([\s\S]*?)<\/p>/g,
        attr: /\bt="(\d+)"/,
        toSeconds: (raw: string) => parseInt(raw, 10) / 1000,
      },
    ];

    for (const { regex, attr, toSeconds } of formats) {
      let match: RegExpExecArray | null = regex.exec(xml);
      if (!match) continue;
      // Reset and iterate from the start of the document
      regex.lastIndex = 0;
      while ((match = regex.exec(xml)) !== null) {
        const attrMatch = match[1].match(attr);
        if (!attrMatch) {
          continue;
        }
        const content = this.decodeHtmlEntities(match[2].replace(/<[^>]+>/g, "").trim());
        if (content) {
          lines.push(`[${this.formatTimestamp(toSeconds(attrMatch[1]))}] ${content}`);
        }
      }
      break;
    }

    return lines;
  }

  private static formatTimestamp(totalSeconds: number): string {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.floor(totalSeconds % 60);
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  }
}
