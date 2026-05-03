// Native messaging client + per-PDF text cache for Summate.
//
// On first use we ping the libpoppler-glib host
// (com.reactome.aicurator.pdftotext); if it's installed we'll extract
// PDF text once per PDF and cache as <basename>.txt next to the .pdf,
// re-extracting when the PDF is newer than its cache. If the host is
// missing or extraction fails for a given PDF, callers fall back to
// sending the PDF as-is (handled in the Summate runner).

import { arrayBufferToBase64 } from '../lib/base64';

const HOST_NAME = 'com.reactome.aicurator.pdftotext';
const PROBE_TIMEOUT_MS = 3000;
const EXTRACT_TIMEOUT_MS = 60_000;
const CHUNK_SIZE = 512 * 1024;

export type Mode = 'pdftotext' | 'pdf-blocks';

let cachedMode: Mode | null = null;
let inflightProbe: Promise<Mode> | null = null;

export async function probeMode(): Promise<Mode> {
  if (cachedMode !== null) return cachedMode;
  if (inflightProbe) return inflightProbe;
  inflightProbe = doProbe().then((m) => {
    cachedMode = m;
    inflightProbe = null;
    return m;
  });
  return inflightProbe;
}

function doProbe(): Promise<Mode> {
  return new Promise((resolve) => {
    let port: chrome.runtime.Port | null = null;
    let settled = false;
    const settle = (mode: Mode) => {
      if (settled) return;
      settled = true;
      try {
        port?.disconnect();
      } catch {
        /* port may already be closed */
      }
      resolve(mode);
    };
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch {
      resolve('pdf-blocks');
      return;
    }
    const timer = setTimeout(() => settle('pdf-blocks'), PROBE_TIMEOUT_MS);
    port.onMessage.addListener((msg) => {
      clearTimeout(timer);
      const m = msg as { type?: string };
      settle(m?.type === 'pong' ? 'pdftotext' : 'pdf-blocks');
    });
    port.onDisconnect.addListener(() => {
      clearTimeout(timer);
      settle('pdf-blocks');
    });
    try {
      port.postMessage({ type: 'ping' });
    } catch {
      clearTimeout(timer);
      settle('pdf-blocks');
    }
  });
}

async function extractText(bytes: ArrayBuffer): Promise<string> {
  const port = chrome.runtime.connectNative(HOST_NAME);
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try {
        port.disconnect();
      } catch {
        /* already closed */
      }
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error('extract timeout')));
    }, EXTRACT_TIMEOUT_MS);
    port.onMessage.addListener((msg) => {
      const m = msg as { type?: string; text?: string; message?: string };
      if (m.type === 'result' && typeof m.text === 'string') {
        clearTimeout(timer);
        const text = m.text;
        finish(() => resolve(text));
      } else if (m.type === 'error') {
        clearTimeout(timer);
        const err = m.message ?? 'extraction failed';
        finish(() => reject(new Error(err)));
      }
    });
    port.onDisconnect.addListener(() => {
      clearTimeout(timer);
      const lastErr = chrome.runtime.lastError?.message;
      finish(() => reject(new Error(lastErr ?? 'host disconnected')));
    });
    void sendChunks(port, bytes).catch((err: unknown) => {
      clearTimeout(timer);
      finish(() =>
        reject(err instanceof Error ? err : new Error(String(err))),
      );
    });
  });
}

async function sendChunks(
  port: chrome.runtime.Port,
  bytes: ArrayBuffer,
): Promise<void> {
  const u8 = new Uint8Array(bytes);
  const totalChunks = Math.max(1, Math.ceil(u8.length / CHUNK_SIZE));
  for (let i = 0; i < totalChunks; i += 1) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, u8.length);
    const slice = u8.slice(start, end);
    const data = await arrayBufferToBase64(slice.buffer);
    port.postMessage({ type: 'extract', chunkIndex: i, totalChunks, data });
  }
}

function txtNameFor(pdfName: string): string {
  return pdfName.replace(/\.pdf$/i, '') + '.txt';
}

// Returns cached or freshly extracted text for one PDF. Returns null
// when the host is unavailable or extraction failed — caller falls
// back to sending the PDF bytes as-is.
export async function getOrExtractText(
  pdfHandle: FileSystemFileHandle,
  pdfDir: FileSystemDirectoryHandle,
): Promise<string | null> {
  const pdfFile = await pdfHandle.getFile();
  const txtName = txtNameFor(pdfHandle.name);

  // Cache hit?
  try {
    const txtHandle = await pdfDir.getFileHandle(txtName);
    const txtFile = await txtHandle.getFile();
    if (txtFile.lastModified >= pdfFile.lastModified) {
      return await txtFile.text();
    }
  } catch {
    /* cache miss — fall through to extract */
  }

  if ((await probeMode()) !== 'pdftotext') return null;

  let text: string;
  try {
    text = await extractText(await pdfFile.arrayBuffer());
  } catch (err) {
    console.warn('[pdfText] extract failed:', pdfHandle.name, err);
    return null;
  }

  try {
    const txtHandle = await pdfDir.getFileHandle(txtName, { create: true });
    const writable = await txtHandle.createWritable();
    await writable.write(text);
    await writable.close();
  } catch (err) {
    console.warn('[pdfText] cache write failed:', txtName, err);
  }

  return text;
}
