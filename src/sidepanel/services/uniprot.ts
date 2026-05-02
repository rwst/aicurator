// UniProt SPARQL client. Single batched VALUES query, human-mandatory
// (taxon:9606), reviewed-first disambiguation, ambiguous→leave-alone.

const SPARQL_ENDPOINT = 'https://sparql.uniprot.org/sparql';

interface SparqlResponse {
  head?: { vars: string[] };
  results?: {
    bindings: Array<Record<string, { type: string; value: string }>>;
  };
}

export interface ResolvedEntity {
  label: string;
  geneSymbol: string;
}

function escapeSparqlLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildQuery(labels: readonly string[]): string {
  const valuesBlock = labels
    .map((l) => `"${escapeSparqlLiteral(l)}"`)
    .join(' ');
  return `PREFIX up: <http://purl.uniprot.org/core/>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX taxon: <http://purl.uniprot.org/taxonomy/>

SELECT DISTINCT ?label ?protein ?gene ?reviewed WHERE {
  VALUES ?label { ${valuesBlock} }
  ?protein a up:Protein ;
           up:organism taxon:9606 ;
           up:reviewed ?reviewed ;
           up:encodedBy ?geneEntity .
  ?geneEntity skos:prefLabel ?gene .
  {
    ?protein up:mnemonic ?label .
  } UNION {
    ?protein up:recommendedName/up:fullName ?label .
  } UNION {
    ?protein up:recommendedName/up:shortName ?label .
  } UNION {
    ?protein up:alternativeName/up:fullName ?label .
  } UNION {
    ?geneEntity skos:prefLabel ?label .
  } UNION {
    ?geneEntity skos:altLabel ?label .
  }
}`;
}

async function runQuery(query: string): Promise<SparqlResponse> {
  const body = new URLSearchParams({ query });
  const resp = await fetch(SPARQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/sparql-results+json',
    },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`UniProt SPARQL ${resp.status}: ${text.slice(0, 200)}`);
  }
  return (await resp.json()) as SparqlResponse;
}

export interface ResolveResult {
  // bareName → canonical gene symbol (uppercased)
  replacements: Map<string, string>;
  // bareName values that hit zero human matches
  noMatch: string[];
  // bareName values that matched ≥2 distinct reviewed gene symbols
  ambiguous: string[];
}

export async function resolveEntities(
  labels: readonly string[],
): Promise<ResolveResult> {
  const replacements = new Map<string, string>();
  const noMatch: string[] = [];
  const ambiguous: string[] = [];
  if (labels.length === 0) {
    return { replacements, noMatch, ambiguous };
  }

  const query = buildQuery(labels);
  const json = await runQuery(query);

  // Group bindings by label.
  const byLabel = new Map<
    string,
    { gene: string; reviewed: boolean; protein: string }[]
  >();
  for (const binding of json.results?.bindings ?? []) {
    const label = binding.label?.value ?? '';
    const gene = (binding.gene?.value ?? '').toUpperCase();
    const reviewed = (binding.reviewed?.value ?? '').toLowerCase() === 'true';
    const protein = binding.protein?.value ?? '';
    if (!label || !gene) continue;
    let arr = byLabel.get(label);
    if (!arr) {
      arr = [];
      byLabel.set(label, arr);
    }
    arr.push({ gene, reviewed, protein });
  }

  for (const label of labels) {
    const hits = byLabel.get(label);
    if (!hits || hits.length === 0) {
      noMatch.push(label);
      continue;
    }
    const reviewedHits = hits.filter((h) => h.reviewed);
    const pool = reviewedHits.length > 0 ? reviewedHits : hits;
    const distinctGenes = new Set(pool.map((h) => h.gene));
    if (distinctGenes.size === 1) {
      const [g] = distinctGenes;
      // Skip no-op replacements (label already equals canonical gene
      // symbol, possibly differing only in case).
      if (g !== label.toUpperCase()) {
        replacements.set(label, g);
      }
    } else {
      ambiguous.push(label);
    }
  }
  return { replacements, noMatch, ambiguous };
}
