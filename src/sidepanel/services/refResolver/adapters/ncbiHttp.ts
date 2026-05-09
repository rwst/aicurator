// Production NcbiPort adapter — drives NCBI E-utilities over HTTP.
//
// Owns:
//   - The two-call ESearch+ESummary dance for searchByDoi (each call
//     consumes one rate-limit token, so a 200-DOI batch costs 2 tokens
//     against the shared 3/sec budget).
//   - The 8-word title fragment + stop-word filter for searchByTitleAuthor.
//   - The strict-single-match rule (returns pmid only when
//     candidateCount === 1).
//   - The shared rate-limit acquire() before every fetch.
//
// Hides:
//   - The articleids round-trip (DOI → PMID → DOI to confirm the
//     match) from the resolver.
//   - URL/query construction and the JSON shapes E-utilities returns.

import type { HttpFetch, NcbiPort } from '../ports';
import type { RateLimiter } from '../rateLimiter';

const ESEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const ESUMMARY = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi';

const STOP_WORDS = new Set([
  'the',
  'of',
  'and',
  'in',
  'for',
  'to',
  'with',
  'on',
  'a',
  'an',
]);

interface ESearchResponse {
  esearchresult?: { idlist?: string[] };
}

interface ESummaryDoc {
  uid?: string;
  articleids?: { idtype: string; value: string }[];
}

interface ESummaryResult {
  result?: Record<string, ESummaryDoc>;
}

export interface HttpNcbiAdapterOptions {
  fetch: HttpFetch;
  limiter: RateLimiter;
}

export function createHttpNcbiAdapter(
  opts: HttpNcbiAdapterOptions,
): NcbiPort {
  async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T> {
    await opts.limiter.acquire(signal);
    const resp = await opts.fetch(url, { signal });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`NCBI ${resp.status}: ${text.slice(0, 200)}`);
    }
    return (await resp.json()) as T;
  }

  return {
    async searchByDoi(inputs, signal) {
      const out = new Map<string, { pmid: string; pmcid?: string }>();
      const withDois = inputs.filter((i) => !!i.doi && i.doi.length > 0);
      if (withDois.length === 0) return out;

      const term = withDois
        .map((i) => `${encodeURIComponent(i.doi)}[AID]`)
        .join('+OR+');
      const esearchUrl =
        `${ESEARCH}?db=pubmed&term=${term}` +
        `&retmode=json&retmax=${withDois.length}`;
      const esearch = await fetchJson<ESearchResponse>(esearchUrl, signal);
      const pmids = esearch.esearchresult?.idlist ?? [];
      if (pmids.length === 0) return out;

      const esumUrl = `${ESUMMARY}?db=pubmed&id=${pmids.join(',')}&retmode=json`;
      const esum = await fetchJson<ESummaryResult>(esumUrl, signal);
      const docs = esum.result ?? {};

      const doiMap = new Map<string, { pmid: string; pmcid?: string }>();
      for (const pmid of pmids) {
        const doc = docs[pmid];
        if (!doc?.articleids) continue;
        let resolvedDoi: string | undefined;
        let resolvedPmcid: string | undefined;
        for (const aid of doc.articleids) {
          if (aid.idtype === 'doi') resolvedDoi = aid.value.toLowerCase();
          else if (aid.idtype === 'pmcid') resolvedPmcid = aid.value;
        }
        if (resolvedDoi) {
          doiMap.set(resolvedDoi, { pmid, pmcid: resolvedPmcid });
        }
      }

      for (const i of withDois) {
        const hit = doiMap.get(i.doi.toLowerCase());
        if (hit) out.set(i.id, hit);
      }
      return out;
    },

    async searchByTitleAuthor(q, signal) {
      const titleFrag = buildTitleFragment(q.title);
      if (!titleFrag || !q.firstAuthor) {
        return { candidateCount: 0 };
      }
      let term = `${titleFrag}[TITL]+AND+${encodeURIComponent(q.firstAuthor)}[AU]`;
      if (q.year) term += `+AND+${q.year}[DP]`;
      const url = `${ESEARCH}?db=pubmed&term=${term}&retmode=json`;
      const esearch = await fetchJson<ESearchResponse>(url, signal);
      const ids = esearch.esearchresult?.idlist ?? [];
      // Strict single-match rule.
      if (ids.length !== 1) return { candidateCount: ids.length };
      return { pmid: ids[0], candidateCount: 1 };
    },
  };
}

function buildTitleFragment(title: string): string {
  const words = title
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z0-9-]/g, ''))
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w.toLowerCase()))
    .slice(0, 8);
  return words.join('+');
}
