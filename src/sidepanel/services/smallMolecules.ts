// Heuristic classifier for "this is obviously not a protein, don't query
// UniProt for it". Conservative — false positives (real proteins
// classified as small molecules) just mean we leave the name unchanged,
// which is the same outcome as "no UniProt match".
//
// Maintained as a hand-curated set + a couple of patterns. Extend the
// set when curators report common metabolites that slipped through.

const KNOWN_NON_PROTEINS: ReadonlySet<string> = new Set([
  // Nucleotides
  'ATP',
  'ADP',
  'AMP',
  'GTP',
  'GDP',
  'GMP',
  'CTP',
  'CDP',
  'CMP',
  'UTP',
  'UDP',
  'UMP',
  'IMP',
  'ITP',
  'IDP',
  'cAMP',
  'cGMP',
  'dATP',
  'dGTP',
  'dCTP',
  'dTTP',
  'dUTP',
  // Cofactors / coenzymes
  'NAD',
  'NADH',
  'NAD+',
  'NADP',
  'NADPH',
  'NADP+',
  'FAD',
  'FADH',
  'FADH2',
  'FMN',
  'FMNH2',
  'CoA',
  'CoA-SH',
  'acetyl-CoA',
  'AcCoA',
  'succinyl-CoA',
  'malonyl-CoA',
  'palmitoyl-CoA',
  'tetrahydrobiopterin',
  'BH4',
  'biotin',
  'pyridoxal phosphate',
  'PLP',
  'thiamine pyrophosphate',
  'TPP',
  'S-adenosylmethionine',
  'SAM',
  'S-adenosylhomocysteine',
  'SAH',
  // Sugars and glycolytic intermediates
  'glucose',
  'fructose',
  'galactose',
  'sucrose',
  'lactose',
  'mannose',
  'ribose',
  'deoxyribose',
  'glucose-6-phosphate',
  'glucose-1-phosphate',
  'fructose-6-phosphate',
  'fructose-1,6-bisphosphate',
  'fructose-2,6-bisphosphate',
  'glyceraldehyde-3-phosphate',
  'dihydroxyacetone phosphate',
  '1,3-bisphosphoglycerate',
  '3-phosphoglycerate',
  '2-phosphoglycerate',
  'phosphoenolpyruvate',
  'PEP',
  'G6P',
  'F6P',
  'F1,6BP',
  'F2,6BP',
  'G3P',
  'GAP',
  'DHAP',
  '3-PG',
  '2-PG',
  '1,3-BPG',
  'PEP',
  // TCA cycle
  'pyruvate',
  'lactate',
  'citrate',
  'isocitrate',
  'cis-aconitate',
  'α-ketoglutarate',
  'alpha-ketoglutarate',
  '2-oxoglutarate',
  'succinate',
  'fumarate',
  'malate',
  'oxaloacetate',
  // Amino acids (free) and common small biomolecules
  'glycine',
  'alanine',
  'valine',
  'leucine',
  'isoleucine',
  'proline',
  'phenylalanine',
  'tryptophan',
  'methionine',
  'serine',
  'threonine',
  'cysteine',
  'tyrosine',
  'asparagine',
  'glutamine',
  'lysine',
  'arginine',
  'histidine',
  'aspartate',
  'glutamate',
  'aspartic acid',
  'glutamic acid',
  'urea',
  'creatine',
  'creatinine',
  'cholesterol',
  'glycerol',
  'glycerol-3-phosphate',
  'choline',
  'ethanolamine',
  // Inorganic / gases / water
  'water',
  'H2O',
  'O2',
  'CO2',
  'NO',
  'N2',
  'NH3',
  'NH4+',
  'H+',
  'OH-',
  'phosphate',
  'pyrophosphate',
  'Pi',
  'PPi',
  // Reactive species / common cofactor partners
  'O2-',
  'H2O2',
  'GSH',
  'GSSG',
  'glutathione',
  'reduced glutathione',
  'oxidized glutathione',
]);

// Ion-shape pattern: 1–2 letter symbol, optional digit, +/- charge.
// Examples: Ca2+, Mg2+, Na+, K+, Cl-, Zn2+, Fe2+, Fe3+, Cu2+, Mn2+, HCO3-.
const ION_RE = /^[A-Z][a-z]?(?:O\d|HCO3|\d+)?[+\-]$/;

// Names that end in -phosphate/-bisphosphate/-triphosphate are
// overwhelmingly metabolites (e.g. "fructose-1,6-bisphosphate").
const PHOSPHATE_SUFFIX_RE = /-(?:bis|tri|tetra|mono)?phosphate$/i;

export function isLikelySmallMolecule(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (KNOWN_NON_PROTEINS.has(trimmed)) return true;
  // Case-insensitive lookup catches "ATP" vs "atp" but only for
  // single-token candidates to avoid breaking multi-word protein names.
  if (
    !/\s/.test(trimmed) &&
    KNOWN_NON_PROTEINS.has(trimmed.toLowerCase())
  )
    return true;
  if (
    !/\s/.test(trimmed) &&
    KNOWN_NON_PROTEINS.has(trimmed.toUpperCase())
  )
    return true;
  if (ION_RE.test(trimmed) && trimmed.length <= 6) return true;
  if (PHOSPHATE_SUFFIX_RE.test(trimmed)) return true;
  return false;
}
