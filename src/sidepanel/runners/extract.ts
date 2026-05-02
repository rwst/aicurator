// Extract runner — orchestrates the Phase-6 pipeline:
//   1. Read picked PDFs into memory.
//   2. Copy them into <project>/PDF/ (preserve basenames).
//   3. LLM call with PDFs + system prompt + JSON schema.
//   4. Parse + validate JSON.
//   5. JS-enforced no-fabrication on inline PMIDs.
//   6. NCBI DOI-batch resolution + title+author fallback.
//   7. Source ladder per reaction (top-5 refs).
//   8. Build header + reaction rows.
//   9. Sheets values:batchUpdate.
//  10. Magic file stage update.
//  11. Log breakdown.

import type { Log } from '../services/log';
import type { Provider } from '../llm/provider';
import { EXTRACT_SYSTEM_PROMPT } from '../prompts/extract.system';
import { validate } from '../services/jsonSchema';
import { resolveByDoi, resolveByTitleAuthor } from '../services/ncbi';
import {
  batchUpdateValues,
  getSheetName,
  getValues,
  quoteSheet,
} from '../services/sheets';

export interface ExtractInput {
  pathwayName: string;
  pdfHandles: FileSystemFileHandle[];
  spreadsheetId: string;
  gid: string;
  projectDir: FileSystemDirectoryHandle;
  provider: Provider;
  log: Log;
  signal: AbortSignal;
}

interface RawReference {
  marker: string;
  pmid: string;
  doi: string;
  pmcid: string;
  publisher_url: string;
  title: string;
  firstAuthor: string;
  year: string;
  journal: string;
  type: string;
  pmid_source: string;
}

interface RawReaction {
  title: string;
  inputs: string;
  outputs: string;
  catalyst: string;
  regulators: string;
  reviews: string;
  references: RawReference[];
}

interface RawExtractOutput {
  reactions: RawReaction[];
  missingPathwayCoverage?: boolean;
}

interface ResolvedRef extends RawReference {
  effectivePmid: string;
  effectivePmidSource: '' | 'inline' | 'esearch:doi' | 'esearch:title-author';
}

const HEADER_ROW = [
  'Title',
  'Summation',
  'Inputs',
  'Outputs',
  'Catalyst',
  'Regulators',
  'Reviews',
  'Source1',
  'Source2',
  'Source3',
  'Source4',
  'Source5',
];

const EXTRACT_SCHEMA = {
  type: 'object' as const,
  required: ['reactions'],
  additionalProperties: true,
  properties: {
    reactions: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        required: [
          'title',
          'inputs',
          'outputs',
          'catalyst',
          'regulators',
          'reviews',
          'references',
        ],
        additionalProperties: true,
        properties: {
          title: { type: 'string' as const },
          inputs: { type: 'string' as const },
          outputs: { type: 'string' as const },
          catalyst: { type: 'string' as const },
          regulators: { type: 'string' as const },
          reviews: { type: 'string' as const },
          references: {
            type: 'array' as const,
            items: {
              type: 'object' as const,
              required: [
                'marker',
                'pmid',
                'doi',
                'pmcid',
                'publisher_url',
                'title',
                'firstAuthor',
                'year',
                'journal',
                'type',
                'pmid_source',
              ],
              additionalProperties: true,
              properties: {
                marker: { type: 'string' as const },
                pmid: { type: 'string' as const },
                doi: { type: 'string' as const },
                pmcid: { type: 'string' as const },
                publisher_url: { type: 'string' as const },
                title: { type: 'string' as const },
                firstAuthor: { type: 'string' as const },
                year: { type: 'string' as const },
                journal: { type: 'string' as const },
                type: { type: 'string' as const },
                pmid_source: { type: 'string' as const },
              },
            },
          },
        },
      },
    },
    missingPathwayCoverage: { type: 'boolean' as const },
  },
};

async function readPdfBytes(handle: FileSystemFileHandle): Promise<ArrayBuffer> {
  const file = await handle.getFile();
  return await file.arrayBuffer();
}

// Pre-flight check: returns true if the sheet's row 1 contains anything
// that isn't our exact 12-column header. Used by the ExtractTab to fire
// the "sheet has unrelated data — overwrite?" modal on first runs.
//
// On any error reading the sheet, returns false — the runner itself
// will surface the error if it can't write later.
export async function hasUnrelatedSheetData(
  spreadsheetId: string,
  gid: string,
): Promise<boolean> {
  try {
    const sheetName = await getSheetName(spreadsheetId, gid);
    const sheetRef = quoteSheet(sheetName);
    const rows: string[][] = await getValues(spreadsheetId, `${sheetRef}!A1:L1`);
    const r0: string[] | undefined = rows[0];
    if (!r0 || r0.every((c: string) => !c)) return false;
    if (
      r0.length === HEADER_ROW.length &&
      r0.every((c: string, i: number) => c === HEADER_ROW[i])
    )
      return false;
    return true;
  } catch {
    return false;
  }
}

async function writeDebugFile(
  projectDir: FileSystemDirectoryHandle,
  name: string,
  content: string,
): Promise<void> {
  try {
    const fh = await projectDir.getFileHandle(name, { create: true });
    const writable = await fh.createWritable();
    await writable.write(content);
    await writable.close();
  } catch (err) {
    console.warn(`[aicurator] failed to write ${name}:`, err);
  }
}

async function copyPdfsIntoProject(
  pdfs: { name: string; bytes: ArrayBuffer }[],
  projectDir: FileSystemDirectoryHandle,
): Promise<void> {
  const pdfDir = await projectDir.getDirectoryHandle('PDF', { create: true });
  for (const pdf of pdfs) {
    const fh = await pdfDir.getFileHandle(pdf.name, { create: true });
    const writable = await fh.createWritable();
    await writable.write(pdf.bytes);
    await writable.close();
  }
}

function extractJsonObject(raw: string): unknown {
  // Be lenient: accept fenced ```json blocks, leading/trailing prose.
  let s = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(s);
  if (fence) s = fence[1].trim();
  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace < 0) {
    throw new Error('LLM response did not contain a JSON object');
  }
  return JSON.parse(s.slice(firstBrace, lastBrace + 1));
}

// JS-enforced no-fabrication: an LLM-claimed inline PMID must literally
// appear in the joined PDF text. We do not have PDF text-extraction
// here in v2601; this pass therefore strips ALL pmid_source="inline"
// PMIDs that we cannot prove. Result: the resolver re-discovers them
// via DOI ESearch, which is the safe path. If/when we add PDF text
// extraction (e.g. via pdfjs-dist), we can reinstate verbatim
// confirmation.
function stripUnverifiedInlinePmids(reactions: RawReaction[]): number {
  let stripped = 0;
  for (const r of reactions) {
    for (const ref of r.references) {
      if (ref.pmid_source === 'inline' && ref.pmid) {
        ref.pmid = '';
        ref.pmid_source = '';
        stripped += 1;
      }
    }
  }
  return stripped;
}

function ladderUrl(ref: ResolvedRef): string {
  if (ref.effectivePmid)
    return `https://pubmed.ncbi.nlm.nih.gov/${ref.effectivePmid}/`;
  if (ref.pmcid) return `https://www.ncbi.nlm.nih.gov/pmc/articles/${ref.pmcid}/`;
  if (ref.doi) return `https://doi.org/${ref.doi}`;
  if (
    ref.publisher_url &&
    /^https?:\/\//.test(ref.publisher_url) &&
    !/\s/.test(ref.publisher_url)
  )
    return ref.publisher_url;
  return '';
}

const TYPE_RANK: Record<string, number> = {
  primary: 0,
  'meta-analysis': 1,
  review: 2,
};

function pickTopFiveSources(refs: ResolvedRef[]): string[] {
  const sorted = [...refs].sort((a, b) => {
    const ta = TYPE_RANK[a.type] ?? 3;
    const tb = TYPE_RANK[b.type] ?? 3;
    if (ta !== tb) return ta - tb;
    const ya = parseInt(a.year || '0', 10);
    const yb = parseInt(b.year || '0', 10);
    return yb - ya; // newer first within type
  });
  const slots: string[] = ['', '', '', '', ''];
  let filled = 0;
  for (const ref of sorted) {
    if (filled >= 5) break;
    const url = ladderUrl(ref);
    if (url) {
      slots[filled] = url;
      filled += 1;
    }
  }
  return slots;
}

export interface ExtractReport {
  totalReactions: number;
  branches: number;
  gaps: number;
  transports: number;
  reversiblePairs: number;
  uniqueRefs: number;
  ladderBreakdown: { pubmed: number; pmc: number; doi: number; publisher: number; blank: number };
  pmidSourceBreakdown: { inline: number; doi: number; titleAuthor: number };
  missingPathwayCoverage: boolean;
}

export async function runExtract(input: ExtractInput): Promise<ExtractReport> {
  const { log, signal } = input;

  // 1. Read PDFs into memory.
  log.append('init', `Extract starting · pathway: "${input.pathwayName}"`);
  log.append('info', `reading ${input.pdfHandles.length} PDFs…`);
  const pdfs: { name: string; bytes: ArrayBuffer }[] = [];
  for (const h of input.pdfHandles) {
    if (signal.aborted) throw new Error('aborted');
    const bytes = await readPdfBytes(h);
    pdfs.push({ name: h.name, bytes });
  }
  log.append('ok', `read ${pdfs.length} PDFs (${pdfs.reduce((s, p) => s + p.bytes.byteLength, 0)} bytes total)`);

  // 2. Copy into <project>/PDF/.
  log.append('info', `copying PDFs into project's PDF/ subdirectory…`);
  await copyPdfsIntoProject(pdfs, input.projectDir);
  log.append('ok', `${pdfs.length} PDFs copied`);

  // 3. LLM call.
  log.append('info', `calling provider with ${pdfs.length} PDFs (this may take 1–2 minutes)…`);
  const userText = `Pathway: ${input.pathwayName}

Extract the reaction graph from the attached PDFs. Output the JSON object per the schema in the system prompt.`;
  const llmStart = Date.now();
  const result = await input.provider.call(
    {
      systemPrompt: EXTRACT_SYSTEM_PROMPT,
      userText,
      pdfs,
      schema: EXTRACT_SCHEMA,
      maxOutputTokens: 32768,
    },
    signal,
  );
  log.append(
    'ok',
    `LLM responded in ${((Date.now() - llmStart) / 1000).toFixed(1)}s` +
      (result.usage ? ` · ${result.usage.input}+${result.usage.output} tokens` : ''),
  );

  // Always dump the raw response into the project dir so the curator can
  // inspect it on parse failure without re-running the (expensive) LLM call.
  await writeDebugFile(input.projectDir, 'extract-response.txt', result.text);

  // 4. Parse + validate.
  let parsed: unknown;
  try {
    parsed = extractJsonObject(result.text);
  } catch (err) {
    log.append('err', `JSON parse failed: ${(err as Error).message}`);
    log.append(
      'info',
      `response head (200ch): ${result.text.slice(0, 200)}`,
    );
    log.append(
      'info',
      `response tail (200ch): ${result.text.slice(-200)}`,
    );
    log.append(
      'info',
      `full response saved to <project>/extract-response.txt (${result.text.length} chars)`,
    );
    throw err;
  }
  try {
    validate(parsed, EXTRACT_SCHEMA);
  } catch (err) {
    log.append('err', `schema validation failed: ${(err as Error).message}`);
    throw err;
  }
  const output = parsed as RawExtractOutput;

  return await processExtractedOutput(output, {
    spreadsheetId: input.spreadsheetId,
    gid: input.gid,
    projectDir: input.projectDir,
    log: input.log,
    signal: input.signal,
  });
}

export interface ProcessOutputContext {
  spreadsheetId: string;
  gid: string;
  projectDir: FileSystemDirectoryHandle;
  log: Log;
  signal: AbortSignal;
}

async function processExtractedOutput(
  output: RawExtractOutput,
  ctx: ProcessOutputContext,
): Promise<ExtractReport> {
  const { log, signal } = ctx;

  // 5. No-fabrication enforcement.
  const stripped = stripUnverifiedInlinePmids(output.reactions);
  if (stripped > 0) {
    log.append(
      'warn',
      `stripped ${stripped} unverified inline PMIDs (no PDF text-extraction yet — re-resolve via DOI ESearch)`,
    );
  }

  // 6. NCBI resolution.
  const allRefs: { reactionIdx: number; refIdx: number; ref: RawReference }[] = [];
  output.reactions.forEach((r, ri) => {
    r.references.forEach((ref, refIdx) => {
      allRefs.push({ reactionIdx: ri, refIdx, ref });
    });
  });

  const doiInputs = allRefs
    .filter((x) => x.ref.doi)
    .map((x) => ({
      marker: `${x.reactionIdx}:${x.refIdx}`,
      doi: x.ref.doi,
    }));
  log.append('info', `resolving ${doiInputs.length} DOIs via NCBI E-utilities…`);
  let doiHits = 0;
  if (doiInputs.length > 0) {
    try {
      const resolutions = await resolveByDoi(doiInputs);
      for (const x of allRefs) {
        const res = resolutions.get(`${x.reactionIdx}:${x.refIdx}`);
        if (res?.pmid) {
          x.ref.pmid = res.pmid;
          x.ref.pmid_source = 'esearch:doi';
          if (res.pmcid && !x.ref.pmcid) x.ref.pmcid = res.pmcid;
          doiHits += 1;
        }
      }
      log.append('ok', `DOI batch resolved ${doiHits}/${doiInputs.length}`);
    } catch (err) {
      log.append('warn', `DOI batch failed: ${(err as Error).message}`);
    }
  }

  // 6b. Title+author fallback for refs with neither inline nor DOI hit.
  const taCandidates = allRefs.filter(
    (x) => !x.ref.pmid && x.ref.title && x.ref.firstAuthor,
  );
  let taHits = 0;
  for (const x of taCandidates) {
    if (signal.aborted) throw new Error('aborted');
    try {
      const res = await resolveByTitleAuthor({
        title: x.ref.title,
        firstAuthor: x.ref.firstAuthor,
        year: x.ref.year || undefined,
      });
      if (res.pmid) {
        x.ref.pmid = res.pmid;
        x.ref.pmid_source = 'esearch:title-author';
        taHits += 1;
      }
    } catch {
      /* skip on error */
    }
  }
  if (taCandidates.length > 0) {
    log.append('info', `title+author fallback: ${taHits}/${taCandidates.length} resolved`);
  }

  // 7. Build resolved-ref view + ladder walk.
  const ladderBreakdown = { pubmed: 0, pmc: 0, doi: 0, publisher: 0, blank: 0 };
  const sourceColumns: string[][] = output.reactions.map((r) => {
    const resolved: ResolvedRef[] = r.references.map((ref) => ({
      ...ref,
      effectivePmid: ref.pmid,
      effectivePmidSource: (ref.pmid_source as ResolvedRef['effectivePmidSource']) || '',
    }));
    const slots = pickTopFiveSources(resolved);
    for (const slot of slots) {
      if (slot.startsWith('https://pubmed.ncbi.nlm.nih.gov/')) ladderBreakdown.pubmed += 1;
      else if (slot.startsWith('https://www.ncbi.nlm.nih.gov/pmc/')) ladderBreakdown.pmc += 1;
      else if (slot.startsWith('https://doi.org/')) ladderBreakdown.doi += 1;
      else if (slot) ladderBreakdown.publisher += 1;
      else ladderBreakdown.blank += 1;
    }
    return slots;
  });

  // 8. Build sheet rows.
  const dataRows: string[][] = output.reactions.map((r, ri) => {
    const slots = sourceColumns[ri];
    return [
      r.title,
      '', // Summation column — left for Phase 7
      r.inputs,
      r.outputs,
      r.catalyst,
      r.regulators,
      r.reviews,
      slots[0],
      slots[1],
      slots[2],
      slots[3],
      slots[4],
    ];
  });

  // 9. Sheet write: header + data.
  // Resolve gid → sheet name so we write to the correct tab, not the
  // first sheet by default.
  const sheetName = await getSheetName(ctx.spreadsheetId, ctx.gid);
  const sheetRef = quoteSheet(sheetName);
  log.append(
    'info',
    `writing ${dataRows.length + 1} rows to sheet "${sheetName}"…`,
  );
  await batchUpdateValues(ctx.spreadsheetId, [
    { range: `${sheetRef}!A1:L1`, values: [HEADER_ROW] },
    ...(dataRows.length > 0
      ? [
          {
            range: `${sheetRef}!A2:L${dataRows.length + 1}`,
            values: dataRows,
          },
        ]
      : []),
  ]);
  log.append('ok', `sheet written`);

  // 10. Build report.
  const branches = output.reactions.filter((r) => r.title.startsWith('## ')).length;
  const transports = output.reactions.filter((r) =>
    r.title.toLowerCase().startsWith('translocation of'),
  ).length;
  const gaps = output.reactions.filter(
    (r) =>
      r.title.startsWith('(') ||
      r.inputs.includes('(') ||
      r.outputs.includes('('),
  ).length;
  const reversiblePairs = (() => {
    let pairs = 0;
    for (let i = 0; i < output.reactions.length - 1; i += 1) {
      const a = output.reactions[i];
      const b = output.reactions[i + 1];
      if (a.inputs === b.outputs && a.outputs === b.inputs) pairs += 1;
    }
    return pairs;
  })();

  // Inline-source count is 0 for v2601 because the no-fabrication
  // stripper removed them; we still report 0 explicitly so the curator
  // can see the audit trail.
  const pmidSourceBreakdown = {
    inline: 0,
    doi: doiHits,
    titleAuthor: taHits,
  };

  // Unique-ref count: dedupe by best identifier per ref.
  const seen = new Set<string>();
  for (const r of output.reactions) {
    for (const ref of r.references) {
      const key = ref.pmid || ref.doi || ref.pmcid || `${ref.firstAuthor}:${ref.year}:${ref.title}`;
      seen.add(key);
    }
  }

  const report: ExtractReport = {
    totalReactions: output.reactions.length,
    branches,
    gaps,
    transports,
    reversiblePairs,
    uniqueRefs: seen.size,
    ladderBreakdown,
    pmidSourceBreakdown,
    missingPathwayCoverage: !!output.missingPathwayCoverage,
  };

  log.append(
    'ok',
    `Extract complete · ${report.totalReactions} reactions · ${report.branches} branches · ` +
      `${report.gaps} gaps · ${report.transports} transports · ` +
      `${report.reversiblePairs} reversible pairs · ${report.uniqueRefs} unique refs`,
  );
  log.append(
    'info',
    `Source ladder: ${ladderBreakdown.pubmed} PubMed · ${ladderBreakdown.pmc} PMC · ` +
      `${ladderBreakdown.doi} DOI · ${ladderBreakdown.publisher} publisher · ${ladderBreakdown.blank} blank`,
  );
  log.append(
    'info',
    `PMID sources: inline:${pmidSourceBreakdown.inline} · esearch:doi:${pmidSourceBreakdown.doi} · ` +
      `esearch:title-author:${pmidSourceBreakdown.titleAuthor}`,
  );
  if (report.missingPathwayCoverage) {
    log.append('warn', 'LLM reported the pathway has no coverage in the supplied PDFs');
  }

  return report;
}

// ── Mock LLM output for sheet-write testing ──────────────
// Synthetic Extract output that exercises the full post-LLM pipeline:
// subtitle row, gap row with parens, transport-like row, regular reactions
// with refs (some with DOI to exercise NCBI batch, some without).
const MOCK_EXTRACT_OUTPUT: RawExtractOutput = {
  reactions: [
    {
      title: '## Mock branch — kinase cascade',
      inputs: '',
      outputs: '',
      catalyst: '',
      regulators: '',
      reviews: '',
      references: [],
    },
    {
      title: 'Mock-kinase phosphorylates substrate',
      inputs: 'glucose [cytosol] | ATP [cytosol]',
      outputs: 'glucose-6-phosphate [cytosol] | ADP [cytosol]',
      catalyst: 'mock-kinase [cytosol]',
      regulators: '+ AMP [cytosol] | - ATP [cytosol]',
      reviews: 'Mock2026.pdf',
      references: [
        {
          marker: '[1]',
          pmid: '',
          doi: '10.1038/nature12373',
          pmcid: '',
          publisher_url: '',
          title: 'Mock primary research paper on kinase activity',
          firstAuthor: 'Smith',
          year: '2024',
          journal: 'Nature',
          type: 'primary',
          pmid_source: '',
        },
        {
          marker: '[2]',
          pmid: '',
          doi: '',
          pmcid: '',
          publisher_url: 'https://example.com/article-2',
          title: 'Mock review paper',
          firstAuthor: 'Jones',
          year: '2023',
          journal: 'Mock Reviews',
          type: 'review',
          pmid_source: '',
        },
      ],
    },
    {
      title: '(Unknown step: G6P → F6P)',
      inputs: '(glucose-6-phosphate [cytosol])',
      outputs: '(fructose-6-phosphate [cytosol])',
      catalyst: '',
      regulators: '',
      reviews: 'Mock2026.pdf',
      references: [],
    },
    {
      title: 'Translocation of pyruvate from cytosol to mitochondrial matrix (transporter unknown)',
      inputs: 'pyruvate [cytosol]',
      outputs: 'pyruvate [mitochondrial matrix]',
      catalyst: '',
      regulators: '',
      reviews: 'Mock2026.pdf',
      references: [],
    },
    {
      title: 'Reversible isomerase: F6P → F1,6BP',
      inputs: 'fructose-6-phosphate [cytosol] | ATP [cytosol]',
      outputs: 'fructose-1,6-bisphosphate [cytosol] | ADP [cytosol]',
      catalyst: 'phosphofructokinase [cytosol]',
      regulators: '',
      reviews: 'Mock2026.pdf',
      references: [],
    },
    {
      title: 'Reversible isomerase: F1,6BP → F6P',
      inputs: 'fructose-1,6-bisphosphate [cytosol] | ADP [cytosol]',
      outputs: 'fructose-6-phosphate [cytosol] | ATP [cytosol]',
      catalyst: 'phosphofructokinase [cytosol]',
      regulators: '',
      reviews: 'Mock2026.pdf',
      references: [],
    },
  ],
  missingPathwayCoverage: false,
};

export async function runExtractMock(
  ctx: ProcessOutputContext,
): Promise<ExtractReport> {
  ctx.log.append(
    'init',
    'Mock Extract starting — synthetic data, no LLM call, no PDF copy',
  );
  ctx.log.append(
    'info',
    `mock data: ${MOCK_EXTRACT_OUTPUT.reactions.length} reactions`,
  );
  return await processExtractedOutput(MOCK_EXTRACT_OUTPUT, ctx);
}
