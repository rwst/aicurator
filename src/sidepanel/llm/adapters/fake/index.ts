// In-memory fakes for the LLM module's two ports.
//
// The full provider composition runs unchanged against either set —
// the strategies are pure-value, the transport is the only side-effect
// channel, and base64 encoding is straight-line code.

import type { HttpTransport, Base64Encoder } from '../../ports';

export interface SentRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

export interface FakeTransportControls {
  /** Push a canned response onto the queue (FIFO). Each send() pulls the
   *  head; if the queue is empty, send() rejects with a clear error so
   *  test failures point at the missing setup, not "undefined.body". */
  enqueue(resp: { status: number; body: string }): void;
  /** Reject the next send() with this error (e.g. simulate network drop). */
  rejectNextWith(err: Error): void;
  /** Inspect what was sent. */
  sent(): SentRequest[];
}

export function createFakeTransport(): {
  port: HttpTransport;
  controls: FakeTransportControls;
} {
  const sentLog: SentRequest[] = [];
  const queue: { status: number; body: string }[] = [];
  let nextRejection: Error | null = null;

  const port: HttpTransport = {
    async send(req) {
      sentLog.push({
        url: req.url,
        method: req.method,
        headers: { ...req.headers },
        body: req.body,
      });
      if (nextRejection) {
        const err = nextRejection;
        nextRejection = null;
        throw err;
      }
      const next = queue.shift();
      if (!next) {
        throw new Error(
          `fake transport: no canned response queued for ${req.url}`,
        );
      }
      return {
        status: next.status,
        ok: next.status >= 200 && next.status < 300,
        body: next.body,
      };
    },
  };

  const controls: FakeTransportControls = {
    enqueue(resp) {
      queue.push(resp);
    },
    rejectNextWith(err) {
      nextRejection = err;
    },
    sent: () => sentLog.map((s) => ({ ...s, headers: { ...s.headers } })),
  };

  return { port, controls };
}

/** Buffer-based encoder for node-side tests. Identical bytes → string
 *  result as the browser FileReader path.
 *
 *  We deliberately avoid pulling node into the browser tsconfig's
 *  `types` array. The Buffer reference is typed via a minimal local
 *  interface so the app build stays node-free; the test runtime is
 *  node, where globalThis.Buffer exists. */
interface NodeBufferLike {
  from(input: ArrayBuffer): { toString(encoding: 'base64'): string };
}
export function createNodeBase64Encoder(): Base64Encoder {
  return {
    async encode(bytes: ArrayBuffer): Promise<string> {
      const buf = (globalThis as unknown as { Buffer: NodeBufferLike }).Buffer;
      return buf.from(bytes).toString('base64');
    },
  };
}
