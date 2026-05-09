// Production HttpTransport: wraps globalThis.fetch.

import type { HttpTransport } from '../../ports';

export function createFetchTransport(): HttpTransport {
  return {
    async send({ url, method, headers, body, signal }) {
      const resp = await fetch(url, { method, headers, body, signal });
      return {
        status: resp.status,
        ok: resp.ok,
        body: await resp.text(),
      };
    },
  };
}
