import { NextResponse } from "next/server";

// JSON mutation requests are intentionally small. Routes with a documented
// need may opt into a different cap, but all callers still count streamed
// bytes rather than trusting Content-Length.
export const DEFAULT_JSON_BODY_BYTES = 48 * 1024;

export class JsonBodyError extends Error {
  constructor(
    public readonly status: 400 | 413,
    public readonly responseBody: { error: string },
  ) {
    super(responseBody.error);
    this.name = "JsonBodyError";
  }
}

function malformed(): never {
  throw new JsonBodyError(400, { error: "Invalid JSON body" });
}

function oversized(): never {
  throw new JsonBodyError(413, { error: "Request body too large" });
}

function byteLengthOfJson(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

type RequestLike = {
  body?: ReadableStream<Uint8Array> | null;
  json?: () => Promise<unknown>;
};

export async function parseBoundedJson<T = unknown>(
  req: RequestLike,
  maxBytes = DEFAULT_JSON_BODY_BYTES,
): Promise<T> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("JSON body cap must be a positive integer");
  }

  const stream = req.body;
  if (stream && typeof stream.getReader === "function") {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          oversized();
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof JsonBodyError) throw error;
      malformed();
    } finally {
      reader.releaseLock();
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
    } catch {
      malformed();
    }
  }

  // Existing route unit tests use minimal request doubles with only json().
  // This fallback is unavailable to real Request/NextRequest objects because
  // their body is always a stream (or null for an actually empty body).
  if (!(req instanceof Request) && typeof req.json === "function") {
    let value: unknown;
    try {
      value = await req.json();
    } catch {
      malformed();
    }
    if (byteLengthOfJson(value) > maxBytes) oversized();
    return value as T;
  }

  malformed();
}

export function jsonBodyErrorResponse(error: unknown): NextResponse | null {
  return error instanceof JsonBodyError
    ? NextResponse.json(error.responseBody, { status: error.status })
    : null;
}
