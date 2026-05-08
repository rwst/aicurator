import { defineManifest } from '@crxjs/vite-plugin';
import { readFileSync } from 'node:fs';

// `.env` lookup. We read it manually because `manifest.config.ts` runs
// in plain Node before Vite's env machinery activates — `process.env`
// only carries variables actually set in the parent shell, not those in
// `.env`. So both `AICURATOR_OAUTH_CLIENT_ID=… npm run build` (shell) and
// a committed-but-gitignored `.env` file work.
function readDotEnv(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  try {
    const content = readFileSync('.env', 'utf-8');
    for (const raw of content.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
      if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, '').trim();
    }
  } catch {
    /* .env may not exist; that's fine */
  }
  return undefined;
}

const OAUTH_CLIENT_ID =
  readDotEnv('AICURATOR_OAUTH_CLIENT_ID') ?? '__REPLACED_AT_BUILD__';

if (OAUTH_CLIENT_ID === '__REPLACED_AT_BUILD__') {
  console.warn(
    '[manifest.config.ts] AICURATOR_OAUTH_CLIENT_ID is not set — Sheets ' +
      'OAuth will fail at runtime. Add it to .env or export in shell.',
  );
}

// Pinned extension ID for local dev. Public key derived from aicurator.pem
// (private key is gitignored). Extension ID: ficloojffnfibdhflbinbnonaemknfai.
// Omitted from Chrome Web Store builds — the store rejects manifests that
// carry a `key` field (it assigns the ID itself). Set AICURATOR_CWS=1 to
// strip it for submission.
const PINNED_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0uQm/sZ4Ttw8a3Nc8WxdL6an8oomfvyYpeizazfAhNB31xaTdjJiJSlZdcMhXaNnFedptQqVB+YLauOjReRQ650svVT1Ow5FC2G5J0tpyKAdCYb5q3CQE7Bkbz3VEP/2LGMdomtvj0xPdstv49u1ofk2+GPlg/KWOn+H+7Klp6dnZldrpol0kJDOYGjf4R+oVdsbEV/3qgjGqd2e/xqHDBQUsa6YOOLzdXVqqFOYQVSd3ArWdekHruGz4Z2E2BTovXsoXeoKvB0EKfT1upTv0ixaAWH+ltkWaKJB0vsrDoxRlMjlrw0vbu3XAml1KZrim0mZDV9S45KX29nV98sbWQIDAQAB';

const isCwsBuild = process.env.AICURATOR_CWS === '1';

export default defineManifest({
  manifest_version: 3,
  name: 'AICurator',
  version: '26.4.0',
  description: 'Reactome curation workflow side panel',

  ...(isCwsBuild ? {} : { key: PINNED_KEY }),

  permissions: [
    'sidePanel',
    'storage',
    'tabs',
    'downloads',
    'identity',
    'scripting',
    'nativeMessaging',
  ],

  host_permissions: [
    'https://api.openai.com/*',
    'https://api.anthropic.com/*',
    'https://openrouter.ai/*',
    'https://generativelanguage.googleapis.com/*',
    'https://sheets.googleapis.com/*',
    'https://eutils.ncbi.nlm.nih.gov/*',
    'https://sparql.uniprot.org/*',
    'https://rest.uniprot.org/*',
    'https://pmc.ncbi.nlm.nih.gov/*',
    'https://pubmed.ncbi.nlm.nih.gov/*',
  ],

  oauth2: {
    client_id: OAUTH_CLIENT_ID,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  },

  side_panel: {
    default_path: 'src/sidepanel/index.html',
  },

  action: {
    default_title: 'AICurator',
  },

  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },

  content_scripts: [
    {
      matches: ['https://pmc.ncbi.nlm.nih.gov/articles/*'],
      js: ['src/content/pmc-pmid.ts'],
      run_at: 'document_end',
    },
  ],

  // TODO(phase 10): add icons/{16,32,48,128}.png. Omitted in Phase 0
  // because the source logo is a wide wordmark, not a square mark.
});
