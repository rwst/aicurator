import { defineManifest } from '@crxjs/vite-plugin';

const OAUTH_CLIENT_ID =
  process.env.AICURATOR_OAUTH_CLIENT_ID ?? '__REPLACED_AT_BUILD__';

export default defineManifest({
  manifest_version: 3,
  name: 'AICurator',
  version: '26.1.0',
  description: 'Reactome curation workflow side panel',

  // Pinned extension ID. Public key derived from aicurator.pem (private key
  // is gitignored). Extension ID: ficloojffnfibdhflbinbnonaemknfai.
  key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0uQm/sZ4Ttw8a3Nc8WxdL6an8oomfvyYpeizazfAhNB31xaTdjJiJSlZdcMhXaNnFedptQqVB+YLauOjReRQ650svVT1Ow5FC2G5J0tpyKAdCYb5q3CQE7Bkbz3VEP/2LGMdomtvj0xPdstv49u1ofk2+GPlg/KWOn+H+7Klp6dnZldrpol0kJDOYGjf4R+oVdsbEV/3qgjGqd2e/xqHDBQUsa6YOOLzdXVqqFOYQVSd3ArWdekHruGz4Z2E2BTovXsoXeoKvB0EKfT1upTv0ixaAWH+ltkWaKJB0vsrDoxRlMjlrw0vbu3XAml1KZrim0mZDV9S45KX29nV98sbWQIDAQAB',

  permissions: [
    'sidePanel',
    'storage',
    'tabs',
    'downloads',
    'identity',
    'scripting',
  ],

  host_permissions: [
    'https://api.openai.com/*',
    'https://api.anthropic.com/*',
    'https://openrouter.ai/*',
    'https://sheets.googleapis.com/*',
    'https://eutils.ncbi.nlm.nih.gov/*',
    'https://sparql.uniprot.org/*',
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
