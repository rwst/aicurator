import type { ProjectsDirPorts } from '../..';
import { createChromeFsaProdAdapter } from './chromeFsa';
import { createDownloadsProdAdapter } from './downloads';
import { createHandleStoreProdAdapter } from './handleStore';

export function createProdProjectsDirPorts(): ProjectsDirPorts {
  const fsa = createChromeFsaProdAdapter();
  const downloads = createDownloadsProdAdapter();
  const store = createHandleStoreProdAdapter({
    adoptHandle: (handle) => fsa.adoptHandle(handle),
  });
  return { fsa, downloads, store };
}
