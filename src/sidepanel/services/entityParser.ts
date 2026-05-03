// Parser for Reactome reaction-cell entity strings. Splits a pipe-
// delimited cell into entities, peels off scaffolding (regulator
// polarity, stoichiometry, compartment), and further splits each
// entity's name on `:` into one or more colon-separated complex
// components — each is a separate canonical-lookup key, so individual
// proteins inside a complex (e.g. "LANA oligomer:HHV8 ori-P") are
// canonized independently.
//
// Examples:
//   "+ AMP [cytosol] | - ATP [cytosol]"    → 2 entities, 1 component each
//   "2 ATP [cytosol] | glucose [cytosol]"  → 2 entities, 1 component each
//   "(NF-kB [nucleoplasm])"                → 1 gap entity (left alone)
//   "p65:p50 [nucleoplasm]"                → 1 entity with 2 components

export interface ParsedComponent {
  stoich: string;       // "2 " | "" (per-component leading stoichiometry)
  bareName: string;     // "AMP" — the canonical-lookup key
}

export interface ParsedEntity {
  raw: string;          // original token verbatim
  prefix: string;       // "+ " | "- " | "" (regulator polarity)
  stoich: string;       // "2 " | "" (entity-level leading stoichiometry)
  components: ParsedComponent[]; // 1+ colon-separated parts
  compartment: string;  // " [cytosol]" with leading space, or ""
  isGap: boolean;       // true for fully-parenthesized "(...)"
}

const POLARITY_RE = /^([+\-]\s+)/;
const STOICH_RE = /^(\d+\s+)/;
const COMPARTMENT_RE = /\s*(\[[^\]]+\])\s*$/;
const GAP_RE = /^\(.+\)$/;

function parseComponent(raw: string): ParsedComponent {
  let s = raw.trim();
  let stoich = '';
  const m = STOICH_RE.exec(s);
  if (m) {
    stoich = m[1];
    s = s.slice(m[0].length);
  }
  return { stoich, bareName: s.trim() };
}

export function parseEntity(raw: string): ParsedEntity {
  const trimmed = raw.trim();
  if (GAP_RE.test(trimmed)) {
    return {
      raw,
      prefix: '',
      stoich: '',
      components: [],
      compartment: '',
      isGap: true,
    };
  }
  let s = trimmed;
  let prefix = '';
  const polM = POLARITY_RE.exec(s);
  if (polM) {
    prefix = polM[1];
    s = s.slice(polM[0].length);
  }
  let stoich = '';
  const stoichM = STOICH_RE.exec(s);
  if (stoichM) {
    stoich = stoichM[1];
    s = s.slice(stoichM[0].length);
  }
  let compartment = '';
  const compM = COMPARTMENT_RE.exec(s);
  if (compM) {
    compartment = ' ' + compM[1];
    s = s.slice(0, compM.index).trimEnd();
  }
  const components = s.split(':').map(parseComponent);
  return {
    raw,
    prefix,
    stoich,
    components,
    compartment,
    isGap: false,
  };
}

export function parseCell(cell: string): ParsedEntity[] {
  if (!cell) return [];
  return cell.split(' | ').map(parseEntity);
}

// Reattach scaffolding around a (possibly substituted) bare name.
export function reassemble(p: ParsedEntity, replacement: string): string {
  if (p.isGap) return p.raw;
  return `${p.prefix}${p.stoich}${replacement}${p.compartment}`;
}

// Apply a bareName→canonical map to one entity-column cell. Each
// colon-separated component is looked up independently. Entities (or
// individual components) without a replacement keep their original
// form; entities whose components were all unchanged keep their raw
// form verbatim to avoid whitespace normalization.
export function rewriteCell(
  cell: string,
  replacements: Map<string, string>,
): string {
  const entities = parseCell(cell);
  const out = entities.map((e) => {
    if (e.isGap) return e.raw;
    let anyChange = false;
    const rebuilt = e.components
      .map((c) => {
        const canonical = replacements.get(c.bareName);
        if (canonical && canonical !== c.bareName) {
          anyChange = true;
          return `${c.stoich}${canonical}`;
        }
        return `${c.stoich}${c.bareName}`;
      })
      .join(':');
    return anyChange ? reassemble(e, rebuilt) : e.raw;
  });
  return out.join(' | ');
}

// Pre-compile a replacement map into a sorted list of (regex, canonical)
// pairs. Reuse across many free-text rewrites — building a `RegExp` per
// entity per cell is the hot-path bottleneck during Canonize.
export interface CompiledReplacements {
  entries: { re: RegExp; canonical: string }[];
}

export function compileReplacements(
  replacements: Map<string, string>,
): CompiledReplacements {
  const entries = [...replacements.entries()]
    .filter(([k, v]) => k.length >= 3 && k !== v)
    .sort((a, b) => b[0].length - a[0].length)
    .map(([bare, canonical]) => {
      const escaped = bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return { re: new RegExp(`\\b${escaped}\\b`, 'g'), canonical };
    });
  return { entries };
}

// Apply a pre-compiled replacement set to free-form text (Title,
// Summation). Sorted longest-first so "ORC complex" is replaced before
// "ORC". Bare names <3 chars are filtered out at compile time to avoid
// prose collisions.
export function rewriteFreeText(
  text: string,
  compiled: CompiledReplacements,
): string {
  if (!text) return text;
  let out = text;
  for (const { re, canonical } of compiled.entries) {
    out = out.replace(re, canonical);
  }
  return out;
}

// Dev-only assertions. Run via `runChecks()` from the runner during dev.
export function runChecks(): void {
  const cases: {
    input: string;
    expectedComponents: string[]; // bareName per component
    isGap: boolean;
  }[] = [
    { input: 'AMP [cytosol]', expectedComponents: ['AMP'], isGap: false },
    { input: '+ AMP [cytosol]', expectedComponents: ['AMP'], isGap: false },
    { input: '- ATP [cytosol]', expectedComponents: ['ATP'], isGap: false },
    { input: '2 ATP [cytosol]', expectedComponents: ['ATP'], isGap: false },
    { input: '2 ATP', expectedComponents: ['ATP'], isGap: false },
    { input: 'NF-kB', expectedComponents: ['NF-kB'], isGap: false },
    { input: '(NF-kB [nucleoplasm])', expectedComponents: [], isGap: true },
    {
      input: 'LANA oligomer:HHV8 ori-P [nucleoplasm]',
      expectedComponents: ['LANA oligomer', 'HHV8 ori-P'],
      isGap: false,
    },
    {
      input: 'p65:p50 [nucleoplasm]',
      expectedComponents: ['p65', 'p50'],
      isGap: false,
    },
    {
      input: '2 ATP:3 Mg [cytosol]',
      expectedComponents: ['ATP', 'Mg'],
      isGap: false,
    },
  ];
  for (const c of cases) {
    const p = parseEntity(c.input);
    const got = p.components.map((cc) => cc.bareName);
    const same =
      got.length === c.expectedComponents.length &&
      got.every((g, i) => g === c.expectedComponents[i]);
    if (p.isGap !== c.isGap || !same) {
      console.error(
        '[entityParser] check failed for',
        JSON.stringify(c.input),
        '→',
        p,
      );
    }
  }
}
