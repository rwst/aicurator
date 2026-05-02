// Parser for Reactome reaction-cell entity strings. Splits a pipe-
// delimited cell into entities, peels off scaffolding (regulator
// polarity, stoichiometry, compartment), exposes the bare name for
// canonical-replacement lookup, and re-attaches the scaffolding on
// writeback.
//
// Examples:
//   "+ AMP [cytosol] | - ATP [cytosol]"    → 2 entities
//   "2 ATP [cytosol] | glucose [cytosol]"  → 2 entities
//   "(NF-kB [nucleoplasm])"                → 1 gap entity (left alone)

export interface ParsedEntity {
  raw: string;          // original token verbatim
  prefix: string;       // "+ " | "- " | "" (regulator polarity)
  stoich: string;       // "2 " | "" (leading integer stoichiometry)
  bareName: string;     // "AMP" — the canonical-lookup key
  compartment: string;  // " [cytosol]" with leading space, or ""
  isGap: boolean;       // true for fully-parenthesized "(...)"
}

const POLARITY_RE = /^([+\-]\s+)/;
const STOICH_RE = /^(\d+\s+)/;
const COMPARTMENT_RE = /\s*(\[[^\]]+\])\s*$/;
const GAP_RE = /^\(.+\)$/;

export function parseEntity(raw: string): ParsedEntity {
  const trimmed = raw.trim();
  if (GAP_RE.test(trimmed)) {
    return {
      raw,
      prefix: '',
      stoich: '',
      bareName: '',
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
  return {
    raw,
    prefix,
    stoich,
    bareName: s.trim(),
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

// Apply a bareName→canonical map to one entity-column cell. Entities
// without a replacement keep their original raw form.
export function rewriteCell(
  cell: string,
  replacements: Map<string, string>,
): string {
  const entities = parseCell(cell);
  const out = entities.map((e) => {
    if (e.isGap) return e.raw;
    const canonical = replacements.get(e.bareName);
    return canonical ? reassemble(e, canonical) : e.raw;
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
  const cases: { input: string; expectedBare: string; isGap: boolean }[] = [
    { input: 'AMP [cytosol]', expectedBare: 'AMP', isGap: false },
    { input: '+ AMP [cytosol]', expectedBare: 'AMP', isGap: false },
    { input: '- ATP [cytosol]', expectedBare: 'ATP', isGap: false },
    { input: '2 ATP [cytosol]', expectedBare: 'ATP', isGap: false },
    { input: '2 ATP', expectedBare: 'ATP', isGap: false },
    { input: 'NF-kB', expectedBare: 'NF-kB', isGap: false },
    { input: '(NF-kB [nucleoplasm])', expectedBare: '', isGap: true },
    { input: 'LANA oligomer:HHV8 ori-P [nucleoplasm]', expectedBare: 'LANA oligomer:HHV8 ori-P', isGap: false },
  ];
  for (const c of cases) {
    const p = parseEntity(c.input);
    if (p.isGap !== c.isGap || p.bareName !== c.expectedBare) {
      console.error(
        '[entityParser] check failed for',
        JSON.stringify(c.input),
        '→',
        p,
      );
    }
  }
}
