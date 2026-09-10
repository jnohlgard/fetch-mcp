import { z } from "zod";

const parsedLimit = Number.parseInt(process.env.DEFAULT_LIMIT ?? "5000");
export const downloadLimit = Number.isNaN(parsedLimit) ? 5000 : parsedLimit;

const parsedMaxBytes = Number.parseInt(process.env.MAX_RESPONSE_BYTES ?? "10485760"); // 10MB
export const maxResponseBytes = Number.isNaN(parsedMaxBytes) ? 10485760 : parsedMaxBytes;

export const RequestPayloadSchema = z.object({
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  max_length: z.number().int().min(0).optional().default(downloadLimit),
  start_index: z.number().int().min(0).optional().default(0),
  /** Optional proxy URL (e.g. 'http://proxy:8080'). Bun-only: silently ignored when running under Node. */
  proxy: z.string().url().optional(),
});

// Make sure TypeScript treats the fields as optional with defaults
export type RequestPayload = {
  url: string;
  headers?: Record<string, string>;
  max_length?: number;
  start_index?: number;
  /** Optional proxy URL (e.g. 'http://proxy:8080'). Bun-only: silently ignored when running under Node. */
  proxy?: string;
};

export const YouTubeTranscriptPayloadSchema = z.object({
  url: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), {
      message: "Only HTTP and HTTPS URLs are allowed",
    }),
  headers: z.record(z.string(), z.string()).optional(),
  max_length: z.number().int().min(0).optional().default(downloadLimit),
  start_index: z.number().int().min(0).optional().default(0),
  /** Optional proxy URL (e.g. 'http://proxy:8080'). Bun-only: silently ignored when running under Node. */
  proxy: z.string().url().optional(),
  lang: z.string().optional().default("en"),
});

export type YouTubeTranscriptPayload = RequestPayload & {
  lang?: string;
};

export interface TextToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
  [key: string]: unknown;
}
