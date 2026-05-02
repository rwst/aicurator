// NCBI E-utilities client. Implements the DOI-batch resolution path
// (steps 3a + 3b from extract-skill.md) and the per-ref title+author
// fallback (step 3c). All output goes through the strict no-fabrication
// rule: a PMID is only adopted when the network call returned exactly
// one match.

const ESEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const ESUMMARY = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi';

const DOI_BATCH_SIZE = 200;

export type PmidSource = 'esearch:doi' | 'esearch:title-author';

export interface NcbiInput {
  marker: string; // identifier kept for the caller to map results back
  doi?: string;
  pmcid?: string; // populated through DOI resolution if available
}

export interface NcbiResolution {
  marker: string;
  pmid?: string;
  pmcid?: string;
  pmid_source?: PmidSource;
}

interface ESearchResponse {
  esearchresult?: { idlist?: string[] };
}

interface ESummaryResult {
  result?: Record<string, ESummaryDoc>;
}

interface ESummaryDoc {
  uid?: string;
  articleids?: { idtype: string; value: string }[];
}

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

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function fetchJson<T>(url: string): Promise<T> {
  const resp = await fetch(url);
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`NCBI ${resp.status}: ${text.slice(0, 200)}`);
  }
  return (await resp.json()) as T;
}

// ── 3a + 3b: DOI batch resolution ────────────────────────
export async function resolveByDoi(
  inputs: readonly NcbiInput[],
): Promise<Map<string, NcbiResolution>> {
  const out = new Map<string, NcbiResolution>();
  for (const i of inputs) out.set(i.marker, { marker: i.marker });

  const withDois = inputs.filter((i) => !!i.doi && i.doi.length > 0);
  if (withDois.length === 0) return out;

  // For each chunk: ESearch returns PMIDs that match any of the DOIs.
  // ESummary then maps back PMIDs → DOIs via articleids.
  for (const batch of chunk(withDois, DOI_BATCH_SIZE)) {
    const term = batch
      .map((i) => `${encodeURIComponent(i.doi!)}[AID]`)
      .join('+OR+');
    const esearchUrl =
      `${ESEARCH}?db=pubmed&term=${term}` +
      `&retmode=json&retmax=${batch.length}`;
    const esearch = await fetchJson<ESearchResponse>(esearchUrl);
    const pmids = esearch.esearchresult?.idlist ?? [];
    if (pmids.length === 0) continue;

    const esumUrl = `${ESUMMARY}?db=pubmed&id=${pmids.join(',')}&retmode=json`;
    const esum = await fetchJson<ESummaryResult>(esumUrl);
    const docs = esum.result ?? {};

    // Build doi → {pmid, pmcid} map from articleids.
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

    for (const i of batch) {
      const hit = doiMap.get(i.doi!.toLowerCase());
      if (hit) {
        out.set(i.marker, {
          marker: i.marker,
          pmid: hit.pmid,
          pmcid: hit.pmcid,
          pmid_source: 'esearch:doi',
        });
      }
    }
  }
  return out;
}

// ── 3c: per-ref title+author fallback ────────────────────
function buildTitleFragment(title: string): string {
  const words = title
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z0-9-]/g, ''))
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w.toLowerCase()))
    .slice(0, 8);
  return words.join('+');
}

export async function resolveByTitleAuthor(opts: {
  title: string;
  firstAuthor: string;
  year?: string;
}): Promise<{ pmid?: string; pmid_source?: PmidSource }> {
  const titleFrag = buildTitleFragment(opts.title);
  if (!titleFrag || !opts.firstAuthor) return {};
  let term = `${titleFrag}[TITL]+AND+${encodeURIComponent(opts.firstAuthor)}[AU]`;
  if (opts.year) term += `+AND+${opts.year}[DP]`;
  const url = `${ESEARCH}?db=pubmed&term=${term}&retmode=json`;
  const esearch = await fetchJson<ESearchResponse>(url);
  const ids = esearch.esearchresult?.idlist ?? [];
  // Strict single-match rule. Anything other than exactly one is null.
  if (ids.length !== 1) return {};
  return { pmid: ids[0], pmid_source: 'esearch:title-author' };
}
