// Ports for the LLM module. Both are deliberately fetch-shaped — the
// transport ships pre-serialized bodies and returns raw response strings,
// faithful to the wire and trivially testable.

export interface HttpTransport {
  send(req: {
    url: string;
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  }): Promise<{ status: number; ok: boolean; body: string }>;
}

export interface Base64Encoder {
  encode(bytes: ArrayBuffer): Promise<string>;
}
