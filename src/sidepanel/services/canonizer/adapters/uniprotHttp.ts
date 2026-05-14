// Production UniprotPort adapter — drives UniProt SPARQL + REST over
// HTTP. Owns:
//   - SPARQL query construction for two distinct path-sets:
//       GENE_MATCH_PATHS  (skos:prefLabel + skos:altLabel on the
//                          encoded gene entity) — the strict match,
//       ALT_MATCH_PATHS   (up:alternativeName/{fullName,shortName} +
//                          up:recommendedName/shortName on the protein)
//                         — the fallback for protein-name-only synonyms
//                          like "Ku86" that resolve to XRCC5/P13010 but
//                          aren't gene aliases. The descriptive
//                          recommendedName/fullName is deliberately
//                          excluded — it produces long noisy strings
//                          ("X-ray repair cross-complementing protein
//                          5") that would collide across genes.
//   - the human-only filter (taxon:9606),
//   - the reviewed=true SPARQL filter (both passes are reviewed-only;
//     TrEMBL fallback was removed once the alt-name pass made the
//     unreviewed fallback redundantly noisy),
//   - URL encoding for REST `gene:` queries (the previous string-concat
//     was fragile around `+` and `:`),
//   - 60s SPARQL / 15s REST timeouts via `clock.withTimeout` so they
//     can be tested under virtual time.

import type { Clock, GeneHit, HttpFetch, UniprotPort } from '../ports';

const SPARQL_ENDPOINT = 'https://sparql.uniprot.org/sparql';
const REST_SEARCH_ENDPOINT = 'https://rest.uniprot.org/uniprotkb/search';
const SPARQL_TIMEOUT_MS = 60_000;
const REST_TIMEOUT_MS = 15_000;

interface SparqlBinding {
  label?: { type: string; value: string };
  gene?: { type: string; value: string };
  reviewed?: { type: string; value: string };
}

interface SparqlResponse {
  results?: { bindings: SparqlBinding[] };
}

interface MatchPath {
  readonly name: string;
  readonly triple: string;
}

const GENE_MATCH_PATHS: readonly MatchPath[] = [
  { name: 'genePrefLabel', triple: '?geneEntity skos:prefLabel ?label .' },
  { name: 'geneAltLabel', triple: '?geneEntity skos:altLabel ?label .' },
] as const;

const ALT_MATCH_PATHS: readonly MatchPath[] = [
  {
    name: 'altNameFull',
    triple: '?protein up:alternativeName/up:fullName ?label .',
  },
  {
    name: 'altNameShort',
    triple: '?protein up:alternativeName/up:shortName ?label .',
  },
  {
    name: 'recNameShort',
    triple: '?protein up:recommendedName/up:shortName ?label .',
  },
] as const;

function escapeSparqlLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildSparqlQuery(
  labels: readonly string[],
  matchTriple: string,
): string {
  const valuesBlock = labels
    .map((l) => `"${escapeSparqlLiteral(l)}"`)
    .join(' ');
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
  FILTER(?reviewed = true)
}`;
}

interface UniprotRestEntry {
  entryType?: string;
  primaryAccession?: string;
  genes?: { geneName?: { value: string } }[];
}

interface UniprotRestResponse {
  results?: UniprotRestEntry[];
}

export interface HttpUniprotAdapterOptions {
  fetch: HttpFetch;
  clock: Clock;
}

export function createHttpUniprotAdapter(
  opts: HttpUniprotAdapterOptions,
): UniprotPort {
  async function runSparqlPath(
    labels: readonly string[],
    matchTriple: string,
    parentSignal: AbortSignal,
  ): Promise<SparqlResponse | null> {
    const query = buildSparqlQuery(labels, matchTriple);
    return opts.clock.withTimeout(
      SPARQL_TIMEOUT_MS,
      parentSignal,
      async (signal) => {
        const body = new URLSearchParams({ query });
        const resp = await opts.fetch(SPARQL_ENDPOINT, {
          method: 'POST',
          signal,
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
      },
    );
  }

  async function searchSparql(
    paths: readonly MatchPath[],
    labels: readonly string[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, ReadonlyArray<GeneHit>>> {
    if (labels.length === 0) return new Map();
    const errors: Error[] = [];
    const results = await Promise.all(
      paths.map((p) =>
        runSparqlPath(labels, p.triple, signal).catch((err) => {
          // Per-path failures are tolerated when at least one path
          // succeeds — log via console; the orchestrator just sees a
          // smaller bindings list. If ALL paths fail, we surface
          // the failure (test 11: 60s timeout on every path).
          console.warn(
            `[uniprot] ${p.name} path failed:`,
            (err as Error).message,
          );
          errors.push(err as Error);
          return null;
        }),
      ),
    );
    if (errors.length === paths.length) {
      throw errors[0];
    }
    const byLabel = new Map<string, GeneHit[]>();
    for (const json of results) {
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
        arr.push({ geneSymbol: gene, reviewed, taxon: 9606 });
      }
    }
    return byLabel;
  }

  return {
    async searchSparqlReviewed(labels, signal) {
      return searchSparql(GENE_MATCH_PATHS, labels, signal);
    },

    async searchSparqlAlt(labels, signal) {
      return searchSparql(ALT_MATCH_PATHS, labels, signal);
    },

    async searchRest(label, reviewedOnly, signal) {
      return opts.clock.withTimeout(
        REST_TIMEOUT_MS,
        signal,
        async (childSignal) => {
          // `gene:` matches preferred symbol + synonyms,
          // case-insensitive. Use URLSearchParams to escape the colon
          // and `+` correctly — the previous string-concat construction
          // tripped on labels containing those characters.
          const reviewedClause = reviewedOnly ? ' AND reviewed:true' : '';
          const query = `gene:${label} AND organism_id:9606${reviewedClause}`;
          const params = new URLSearchParams({
            query,
            format: 'json',
            fields: 'gene_names,reviewed,accession',
            size: '10',
          });
          const url = `${REST_SEARCH_ENDPOINT}?${params.toString()}`;
          const resp = await opts.fetch(url, { signal: childSignal });
          if (!resp.ok) return [];
          const json = (await resp.json()) as UniprotRestResponse;
          const hits: GeneHit[] = [];
          for (const entry of json.results ?? []) {
            const isReviewed =
              !!entry.entryType &&
              /reviewed \(Swiss-Prot\)/i.test(entry.entryType) &&
              !/unreviewed/i.test(entry.entryType);
            const primary = entry.genes?.[0]?.geneName?.value;
            if (primary) {
              hits.push({
                geneSymbol: primary.toUpperCase(),
                reviewed: isReviewed,
                accession: entry.primaryAccession,
                taxon: 9606,
              });
            }
          }
          // Reviewed-first ordering; the canonizer relies on this for
          // disambiguation.
          hits.sort((a, b) => Number(b.reviewed) - Number(a.reviewed));
          return hits;
        },
      );
    },
  };
}
