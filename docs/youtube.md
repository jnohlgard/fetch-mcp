# YouTube transcripts

- If `yt-dlp` is on PATH (checked once with `which`, cached in static `Fetcher.hasYtDlp`), subtitles are downloaded via `yt-dlp` into an `mktemp -d` dir (`.srv1` format, 30s timeout, cleaned up in `finally`). Any yt-dlp failure **silently falls back** to direct page extraction.
- Direct extraction (`fetchTranscriptDirect`): regex-pulls `ytInitialPlayerResponse` from the watch page HTML, picks the track matching `lang` else the **first** track (silent fallback — the requested language may not be what's returned), then fetches the caption URL through `_fetch` (so SSRF/size limits apply to it too).
- `lang` is regex-validated (`/^[a-zA-Z0-9-]+$/`) in **two** places: inside `fetchTranscriptViaYtDlp` and again in `youtubeTranscript` before the try/catch. The second one is a security check that must not be swallowed by the fallback `catch` — keep both if you refactor.
- `parseTranscriptXml` handles two caption dialects: `<text start="s" dur="s">` (srv1, seconds) and `<p t="ms" d="ms">` (srv3, milliseconds); output is `[m:ss] content` lines prefixed with a `[Transcript language: ...]` header.
