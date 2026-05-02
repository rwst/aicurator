// UniProt SPARQL client.
//
// Strategy: instead of one big VALUES + 6-UNION query (which times out
// at the UniProt server), we issue 5 simple per-match-path queries in
// parallel. Each query is a flat BGP with no UNION, so the planner can
// use indexes directly.
//
// Two-pass to keep response volume manageable:
//   1. Reviewed-only across all paths. Most well-characterized human
//      proteins resolve here with a tiny payload (typically 1–3 bindings).
//   2. Only labels that hit zero reviewed entries fall back to TrEMBL
//      across all paths.
//
// Disambiguation per the plan:
//   - human-mandatory (taxon:9606 in every BGP)
//   - reviewed-first (pass 1 wins over pass 2)
//   - if still ambiguous (≥2 distinct reviewed gene symbols for a label),
//     leave the name unchanged

const SPARQL_ENDPOINT = 'https://sparql.uniprot.org/sparql';
const REST_SEARCH_ENDPOINT = 'https://rest.uniprot.org/uniprotkb/search';
const PER_QUERY_TIMEOUT_MS = 60_000;
const REST_TIMEOUT_MS = 15_000;

interface SparqlResponse {
  results?: {
    bindings: Array<Record<string, { type: string; value: string }>>;
  };
}

const MATCH_PATHS: readonly { name: string; triple: string }[] = [
  { name: 'mnemonic', triple: '?protein up:mnemonic ?label .' },
  {
    name: 'recName',
    triple: '?protein up:recommendedName/up:fullName ?label .',
  },
  {
    name: 'altName',
    triple: '?protein up:alternativeName/up:fullName ?label .',
  },
  { name: 'genePrefLabel', triple: '?geneEntity skos:prefLabel ?label .' },
  { name: 'geneAltLabel', triple: '?geneEntity skos:altLabel ?label .' },
] as const;

function escapeSparqlLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildQuery(
  labels: readonly string[],
  matchTriple: string,
  reviewedOnly: boolean,
): string {
  const valuesBlock = labels
    .map((l) => `"${escapeSparqlLiteral(l)}"`)
    .join(' ');
  const reviewedFilter = reviewedOnly ? 'FILTER(?reviewed = true)' : '';
  return `PREFIX up: <http://purl.uniprot.org/core/>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX taxon: <http://purl.uniprot.org/taxonomy/>

SELECT DISTINCT ?label ?gene ?reviewed WHERE {
  VALUES ?label { ${valuesBlock} }
  ?protein a up:Protein ;
           up:organism taxon:9606 ;
           up:reviewed ?reviewed ;
           up:encodedBy ?geneEntity .
  ?geneEntity skos:prefLabel ?gene .
  ${matchTriple}
  ${reviewedFilter}
}`;
}

async function runQuery(query: string): Promise<SparqlResponse | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PER_QUERY_TIMEOUT_MS);
  try {
    const body = new URLSearchParams({ query });
    const resp = await fetch(SPARQL_ENDPOINT, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/sparql-results+json',
      },
      body,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`UniProt ${resp.status}: ${text.slice(0, 200)}`);
    }
    return (await resp.json()) as SparqlResponse;
  } finally {
    clearTimeout(timer);
  }
}

interface BindingHit {
  gene: string;
  reviewed: boolean;
}

async function queryAllPaths(
  labels: readonly string[],
  reviewedOnly: boolean,
): Promise<Map<string, BindingHit[]>> {
  const queries = MATCH_PATHS.map((p) =>
    buildQuery(labels, p.triple, reviewedOnly),
  );
  const responses = await Promise.all(
    queries.map((q, i) =>
      runQuery(q).catch((err) => {
        console.warn(
          `[uniprot] ${MATCH_PATHS[i].name} path failed:`,
          (err as Error).message,
        );
        return null;
      }),
    ),
  );

  const byLabel = new Map<string, BindingHit[]>();
  for (const json of responses) {
    if (!json) continue;
    for (const binding of json.results?.bindings ?? []) {
      const label = binding.label?.value ?? '';
      const gene = (binding.gene?.value ?? '').toUpperCase();
      const reviewed = binding.reviewed?.value === 'true';
      if (!label || !gene) continue;
      let arr = byLabel.get(label);
      if (!arr) {
        arr = [];
        byLabel.set(label, arr);
      }
      arr.push({ gene, reviewed });
    }
  }
  return byLabel;
}

export interface ResolveResult {
  replacements: Map<string, string>;
  noMatch: string[];
  ambiguous: string[];
}

// REST fallback for labels that SPARQL misses. UniProt's REST search
// supports `gene:` (primary + synonyms), `mnemonic:`, and `protein_name:`
// qualifiers and is case-insensitive, so it catches withdrawn symbols
// and alternate spellings that exact-match SPARQL skips.
interface UniprotRestEntry {
  entryType: string; // "UniProtKB reviewed (Swiss-Prot)" or "UniProtKB unreviewed (TrEMBL)"
  genes?: { geneName?: { value: string } }[];
}
interface UniprotRestResponse {
  results?: UniprotRestEntry[];
}

async function restSearch(
  label: string,
  reviewedOnly: boolean,
): Promise<BindingHit[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REST_TIMEOUT_MS);
  try {
    const reviewedClause = reviewedOnly ? '+AND+reviewed:true' : '';
    const safe = encodeURIComponent(label).replace(/%20/g, '+');
    // `gene:` matches recommended + synonyms; `protein_name:` matches
    // full + alternative names. Both case-insensitive.
    const query = `(gene:${safe}+OR+protein_name:${safe})+AND+organism_id:9606${reviewedClause}`;
    const url =
      `${REST_SEARCH_ENDPOINT}?query=${query}` +
      `&format=json&fields=gene_names,reviewed&size=10`;
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) return [];
    const json = (await resp.json()) as UniprotRestResponse;
    const out: BindingHit[] = [];
    for (const entry of json.results ?? []) {
      const isReviewed =
        /reviewed \(Swiss-Prot\)/i.test(entry.entryType) &&
        !/unreviewed/i.test(entry.entryType);
      const primary = entry.genes?.[0]?.geneName?.value;
      if (primary) {
        out.push({ gene: primary.toUpperCase(), reviewed: isReviewed });
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function restSearchAll(
  labels: readonly string[],
  reviewedOnly: boolean,
): Promise<Map<string, BindingHit[]>> {
  const out = new Map<string, BindingHit[]>();
  // Run in parallel — small batches (<100 labels) are within UniProt's
  // ~25 req/sec rate-limit envelope.
  const results = await Promise.all(
    labels.map((l) => restSearch(l, reviewedOnly)),
  );
  for (let i = 0; i < labels.length; i += 1) {
    const hits = results[i];
    if (hits.length > 0) out.set(labels[i], hits);
  }
  return out;
}

export async function resolveEntities(
  labels: readonly string[],
): Promise<ResolveResult> {
  const replacements = new Map<string, string>();
  const noMatch: string[] = [];
  const ambiguous: string[] = [];
  if (labels.length === 0) return { replacements, noMatch, ambiguous };

  // Pass 1: SPARQL reviewed-only across all match paths.
  const reviewed = await queryAllPaths(labels, true);

  // Pass 2: SPARQL TrEMBL fallback for labels with no reviewed match.
  const unresolvedAfterReviewed = labels.filter((l) => !reviewed.has(l));
  let unreviewed = new Map<string, BindingHit[]>();
  if (unresolvedAfterReviewed.length > 0) {
    unreviewed = await queryAllPaths(unresolvedAfterReviewed, false);
  }

  // Pass 3: REST search for whatever SPARQL didn't catch — handles
  // withdrawn / synonym gene symbols (e.g. "DIESL") that the
  // strict-equality SPARQL paths miss.
  const stillUnresolved = labels.filter(
    (l) => !reviewed.has(l) && !unreviewed.has(l),
  );
  let restReviewed = new Map<string, BindingHit[]>();
  let restUnreviewed = new Map<string, BindingHit[]>();
  if (stillUnresolved.length > 0) {
    restReviewed = await restSearchAll(stillUnresolved, true);
    const stillStillUnresolved = stillUnresolved.filter(
      (l) => !restReviewed.has(l),
    );
    if (stillStillUnresolved.length > 0) {
      restUnreviewed = await restSearchAll(stillStillUnresolved, false);
    }
  }

  // Resolve per label, preferring earlier passes (most authoritative).
  for (const label of labels) {
    const hits =
      reviewed.get(label) ??
      unreviewed.get(label) ??
      restReviewed.get(label) ??
      restUnreviewed.get(label);
    if (!hits || hits.length === 0) {
      noMatch.push(label);
      continue;
    }
    // Prefer reviewed hits within whichever bucket we landed in.
    const reviewedHits = hits.filter((h) => h.reviewed);
    const pool = reviewedHits.length > 0 ? reviewedHits : hits;
    const distinctGenes = new Set(pool.map((h) => h.gene));
    if (distinctGenes.size === 1) {
      const [g] = distinctGenes;
      if (g && g !== label.toUpperCase()) {
        replacements.set(label, g);
      }
    } else {
      ambiguous.push(label);
    }
  }
  return { replacements, noMatch, ambiguous };
}
