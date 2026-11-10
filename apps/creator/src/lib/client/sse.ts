/**
 * Server-sent events for the chat stream: the frame format the chat route writes and an incremental
 * parser the browser uses on the fetch body. Pure, so both sides share one tested definition.
 * @packageDocumentation
 */

export interface SseMessage {
  event: string;
  data: string;
}

/** One frame: `event: <type>` and the JSON payload on a single data line. */
export function encodeSse(event: { type: string }): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Feeds text chunks and returns complete messages; partial frames wait for the next chunk.
 * Multi-line data is joined with newlines, per the SSE format.
 */
export function createSseParser(): { push(chunk: string): SseMessage[]; flush(): SseMessage[] } {
  let buffer = "";
  const parseFrame = (frame: string): SseMessage | null => {
    let event = "message";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    return data.length ? { event, data: data.join("\n") } : null;
  };
  const drain = (final: boolean): SseMessage[] => {
    buffer = buffer.replace(/\r\n?/g, "\n");
    const frames = buffer.split("\n\n");
    buffer = final ? "" : (frames.pop() ?? "");
    return frames.map(parseFrame).filter((message): message is SseMessage => message !== null);
  };
  return {
    push(chunk) {
      buffer += chunk;
      return drain(false);
    },
    flush() {
      return drain(true);
    },
  };
}

/** Reads a fetch response body as SSE messages until it ends. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncIterable<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield* parser.push(decoder.decode(value, { stream: true }));
    }
    yield* parser.push(decoder.decode());
    yield* parser.flush();
  } finally {
    reader.releaseLock();
  }
}
