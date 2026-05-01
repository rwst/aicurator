---
name: extract-reactions
description: Extract a reaction graph for a named pathway from one or more medical/biology review PDFs and emit (1) a CSV (Title, Input, Output, Catalyst, Regulators, Reviews, Source1..Source5 — Source cells use a PubMed > PMC > DOI > publisher URL ladder) and (2) a companion HTML reference list. Supports gaps and parallel branches. Use when a curator wants a first-pass reaction list from literature before drafting Reactome entries.
---

# Extract Reactions Skill

## Purpose

Given one or more review-article PDFs and the name or description of a pathway,
build a reaction graph for that pathway and write two artefacts: a CSV of
reactions for seeding manual Reactome curation, and a companion HTML page
listing every primary reference cited in support of those reactions.
Disconnected graphs, missing intermediate steps, and parallel branches are
all permitted — gaps are marked, not fixed. This is a pre-curation
convenience skill — the output is a draft, not a curated entry.

## Required Inputs

Before doing anything else, ask the curator for, and do not proceed until you have both:

 1. The pathway name or short description
    (e.g. "classical complement activation", "glycolysis from glucose to pyruvate").

 2. Absolute paths to one or more review-article PDFs.

Do not ask about species (assume Homo sapiens), output path (auto-generated from
the pathway name), or any schema options.

## Invocation

 /extract-reactions

No arguments. The skill will prompt for the two inputs above.

## Reading the PDFs

- Read every supplied PDF in full, including figures. Pathway structure lives in
  the diagrams — read the images themselves, not just the figure captions.
- Build the full reaction graph in your head (or scratch notes) before writing
  anything to disk.
- As you identify each reaction, also capture the in-text citation markers
  in the supporting PDFs that vouch for it (numeric `[12]`, `(12, 13)`,
  superscript; or author-year `(Smith et al., 2024)`). For each marker,
  look up only the cited entry in **that PDF's** references list and
  record what you find. Do not parse any PDF's bibliography exhaustively;
  capture refs opportunistically. See the **References & Source Resolution**
  section below for the full workflow.
- If two PDFs describe the same step differently, prefer the most recent publication.
- If the pathway has no coverage at all in the supplied PDFs — no pathway
  figure anywhere, no reaction-level description — stop and report. Partial
  coverage is fine: proceed and mark gaps per the rules below.

## Reaction Model

Each reaction is one CSV row with these fields:

 - **Title** — short verb-phrase describing the step
   (e.g. "Hexokinase phosphorylates glucose to glucose-6-phosphate").
 - **Input** — PhysicalEntities consumed.
 - **Output** — PhysicalEntities produced.
 - **Catalyst** — the single catalytic PhysicalEntity, if the reaction is
   enzyme-catalysed. Blank otherwise. (Just the entity — no GO MF term.)
 - **Regulators** — positive and negative regulators, prefixed `+` or `-`
   (e.g. `+ AMP [cytosol] | - ATP [cytosol]`). Blank if none.
 - **Reviews** — pipe-delimited list of supplied-PDF basenames whose text
   or diagram blurb supports this reaction (e.g.
   `Smith2024.pdf | Jones2023.pdf`). Basename only, no paths and no figure
   references. Each name must match one of the PDFs the curator passed in.
   Order by relevance (most-cited PDF first). Subtitle and gap rows leave
   this blank. **PDF filenames go here, never in Source columns.**
 - **Source1 … Source5** — up to five primary-reference URLs for the
   reaction, one per column. Each cell holds exactly one URL chosen by the
   following ladder, falling through to the next rung when the upper one
   is unavailable:
     1. PubMed: `https://pubmed.ncbi.nlm.nih.gov/<PMID>/`
     2. PMC: `https://www.ncbi.nlm.nih.gov/pmc/articles/PMC<id>/`
     3. DOI: `https://doi.org/<doi>`
     4. Publisher URL — only when the reference printed one inline.
     5. Empty — only if none of the above can be obtained.
   Fill `Source1` first. **Never combine multiple URLs into one cell**,
   never fabricate a URL, and never put PDF filenames or plain-text
   citations here. Triage to ≤5 sources per reaction (see below).

## Entity Rules

- **Text labels only** — no UniProt / ChEBI / GO ID resolution. Write entities
  as they appear in the review, normalized to a single form per entity.
- **Compartments are mandatory** and written in square brackets after the name:
  `glucose [cytosol]`, `ATP [mitochondrial matrix]`, `Ca2+ [endoplasmic reticulum lumen]`.
- **Complexes** use colon notation: `A:B`, `A:B:C`. If the complex has a
  well-known name, use the name instead of the subunit list
  (e.g. `RNA polymerase II [nucleoplasm]`, not the 12-subunit colon string).
- **Stoichiometry** as a leading integer: `2 ATP [cytosol]`.
- **Multiple entities in one field** are pipe-delimited with spaces around the pipe:
  `glucose [cytosol] | ATP [cytosol]`.

## Graph Rules

**Connectivity is not required.** Disconnected graphs are allowed. Include
every reaction the PDFs describe, even if its Inputs do not trace back to any
earlier reaction's Output.

**Gaps are marked with parentheses.** Use parentheses to flag anything the
PDFs imply but do not spell out:

 - An **Input** that ought to come from an upstream reaction but whose
   upstream reaction is not in the PDFs: wrap the entity in parens,
   e.g. `(fructose-1,6-bisphosphate [cytosol])`.
 - An **Output** that is clearly consumed further downstream but whose
   downstream reactions are not in the PDFs: same treatment,
   e.g. `(acetyl-CoA [mitochondrial matrix])`.
 - An **entire inferred bridging reaction** that the curator should be aware
   is missing from the literature but needed to connect two described steps:
   emit a row with a fully parenthesized Title
   (e.g. `(Unknown step: F6P → F1,6BP)`) and parenthesized entities in Input
   and Output. Leave Catalyst, Regulators, and the Source columns blank.
   Set `Reviews` to the PDF that implies the gap so the curator can find
   the context — Source columns stay blank because no primary reference
   can be cited for an inferred missing reaction.

Parentheses are reserved for gap markers. Do not use them for anything else
(notes and qualifiers in the Title go without parens, except the explicit
`(transporter unknown)` annotation defined below).

**Parallel branches use subtitle rows.** When a pathway has parallel branches
(e.g. classical vs alternative complement activation, canonical vs non-canonical
arms, redundant isoform-specific routes), emit a subtitle row before each
branch: Title is `## <branch name>`, all other fields blank. Reactions within
each branch follow in best-effort topological order. Use a single top-level
`## <branch name>` row per branch — do not nest subtitles.

**Compartment changes demand transport reactions.** If a species appears in
compartment X as an output of one reaction and is then consumed in compartment Y
by another reaction (whether or not they are connected in the graph), insert
an explicit transport reaction — even when the review does not name a
transporter and even when the transporter is unknown. Title such rows
`Translocation of <entity> from <X> to <Y>`, with Input `<entity> [X]` and
Output `<entity> [Y]`. Leave Catalyst blank if unknown; set `Reviews` to the
PDF that implies the compartment change and append `(transporter unknown)`
to the Title if so. The Source columns can be filled if the review cites a
primary reference for the transport step, otherwise they stay blank.
These inferred transport rows are policy inferences, not gaps — do not
parenthesize them.

**Reversible reactions.** Emit two rows — one forward, one reverse — with
swapped Input and Output and titles reflecting direction
(e.g. "Phosphoglucose isomerase converts G6P to F6P" and "Phosphoglucose
isomerase converts F6P to G6P"). The forward row comes first.

**Ordering.** Within each branch (or the whole CSV if there are no parallel
branches), output reactions in best-effort topological order: upstream before
downstream. Reversible pairs: forward first, then reverse, placed at the
forward reaction's topological position. Cycles and disconnected components
are permitted; order disconnected pieces by their appearance in the PDFs.

## References & Source Resolution

A four-step process woven around reaction extraction. Steps 1–2 happen
during reading; step 3 is the only network call; step 4 is local assembly.

**1. Capture citations during reading (no network).** As you identify each
reaction, capture which in-text citation markers in the supporting PDFs
vouch for it: numeric (`[12]`, `(12, 13)`, superscript) or author-year
(`(Smith et al., 2024)`). For each marker, look up the matching entry in
**only that PDF's references list** — do not parse other PDFs'
bibliographies, and never parse a bibliography exhaustively. Record just
enough to identify the cited paper:

    { pdf, marker, authors, year, title, journal, doi?, pmid?, pmcid?,
      publisher_url? }

**2. Maintain a dedup table (no network).** Keep a single internal
`seen_refs` table, keyed by best-available identifier in this priority:
PMID > DOI > PMC > normalized first-author + year + title. The same paper
cited from many reactions becomes one entry. Track which PDFs each ref was
seen in (for the HTML deliverable's audit annotation). Also classify each
ref as `primary research`, `meta-analysis`, or `review/editorial/commentary`
— the triage step needs this.

**3. Resolution via NCBI E-utilities (two batched calls + per-ref
fallback).** After all reactions are extracted, resolve PMIDs in three
sub-steps against `eutils.ncbi.nlm.nih.gov`. Step 3a + 3b are batched;
step 3c is one call per no-DOI ref.

**3a. ESearch** — returns the PMIDs that exist in PubMed for the given
DOIs, as one flat list (no per-DOI mapping yet):

    https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi
        ?db=pubmed
        &term=<doi1>[AID]+OR+<doi2>[AID]+OR+...+OR+<doiN>[AID]
        &retmode=json
        &retmax=<N>

URL-encode each DOI's slashes as `%2F` in the `term`. Set `retmax` to at
least the number of input DOIs. The response's `esearchresult.idlist` is
the set of PMIDs that match.

**3b. ESummary** — returns each PMID's metadata, including its DOI in
`articleids`, so we can invert the mapping:

    https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi
        ?db=pubmed
        &id=<pmid1,pmid2,...>
        &retmode=json

For each result in `result.<pmid>.articleids`, find the entry where
`idtype == "doi"`. That gives `(doi → pmid)`. Build the map by inverting,
then merge the PMIDs into `seen_refs`.

If the unique-DOI count exceeds E-utilities' practical batch size (~200
DOIs in one URL is generally fine; chunk if longer), split into the
minimum number of ESearch calls (and a corresponding ESummary call per
chunk). Treat the whole pair-set as one logical resolution step.

**3c. Per-ref title+author fallback (one ESearch per no-DOI ref).** For
each ref that — after step 3b — still has no PMID *and* no DOI but
*does* have a first-author last name and a usable title fragment, issue
one ESearch:

    https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi
        ?db=pubmed
        &term=<title-fragment>[TITL]+AND+<first-author-lastname>[AU]
        &retmode=json

Construct the query as follows:

 - `<title-fragment>`: the first 6–10 distinctive words of the title
   (skip articles and prepositions: "the", "of", "and", "in", "for",
   "to", "with", "on"). Separate words with `+`. Do not wrap in quotes
   — PubMed treats space-separated `[TITL]` words as AND-combined,
   which is forgiving of small variations.
 - `<first-author-lastname>`: the surname of the first listed author.
 - If the ref has a year, also append `+AND+<year>[DP]` to disambiguate
   further. Example:
   `term=Inhibition+of+autophagy[TITL]+AND+Levine[AU]+AND+2007[DP]`

**Strict single-match rule.** Only adopt the returned PMID if
`esearchresult.idlist` contains **exactly one** entry. If it contains
zero or more than one, leave the PMID null — do not pick one
arbitrarily, do not run a follow-up disambiguation call, do not guess.
Step 3c never adds an ambiguous PMID to `seen_refs`; an ambiguous
result is the same as no result.

This step is bounded by the number of refs reaching it, which is
typically small (most modern papers have DOIs). One call per ref. Do
**not** batch with OR'd `(title[TITL] AND au[AU])` groups — the
fuzzy-match step that would be required to invert the ESummary back to
input refs is exactly the operation that risks misattributed PMIDs.

**General rules across step 3.** Do **not** make additional ESearch
calls beyond what's specified here, do **not** call ELink or EFetch,
do **not** call any non-NCBI service for PMID lookup, and do **not**
follow DOI redirects to discover publisher URLs.

No NCBI API key is required — total call count (one ESearch + one
ESummary + a small per-ref tail) stays well under the unauthenticated
3 req/sec rate limit.

If any call fails for any reason — network blocked, host moved again,
non-200 response, malformed JSON, no `idlist`, no `articleids`,
ambiguous match — refs that had no inline PMID stay PMID-less and fall
through to the next ladder rung in step 4. The deliverables still
produce.

### Absolute no-fabrication rule (read this twice)

A PMID may enter `seen_refs` from **only three** sources:

 1. It was printed verbatim in the PDF you read (in a reference list
    entry, an in-text annotation, or a figure caption). You can quote
    the surrounding text.
 2. It was returned by the ESearch+ESummary pair in step 3a/3b, mapped
    from a DOI you also extracted from a PDF, where both calls returned
    HTTP 200 and the DOI appeared in the ESummary response's
    `articleids`.
 3. It was returned by a step-3c title+author ESearch where
    `esearchresult.idlist` contained **exactly one** PMID — for a ref
    whose title and first-author you also extracted from a PDF.

**Any other PMID is fabricated and forbidden**, including PMIDs that
"feel right" because the paper is well-known, PMIDs you remember from
training data, PMIDs derived by guessing-from-author-and-year, PMIDs
inferred by analogy to similar papers, and PMIDs picked from a step-3c
result that returned more than one match. There is no high-confidence
memory exception. If the network calls fail, return zero matches, or
return ambiguous matches, the ref does **not** get a PubMed URL — it
walks down to the DOI rung (if it has a DOI) or further. Better to ship
a CSV with DOI URLs and blanks than a CSV with hallucinated PubMed IDs
that look correct but point to the wrong paper.

To make this auditable, every ref in `seen_refs` must carry a
`pmid_source` field with one of these values:

 - `"inline:<pdf basename>"` — printed in that PDF.
 - `"esearch:doi"` — returned by step 3a/3b (DOI-batch resolution).
 - `"esearch:title-author"` — returned by step 3c (single-match
   title+author search).
 - `null` — no PMID. The Source cell will not get a PubMed URL.

When walking the ladder in step 4, only emit a PubMed URL if
`pmid_source` is non-null. The post-write report breaks down PubMed URLs
by `pmid_source` so the curator can immediately see whether and how the
network calls succeeded — if you ship 47 PubMed URLs with `esearch:*`
but the calls failed, that is a bug; the report would show
`esearch:doi: 0` and `esearch:title-author: 0` and the curator would
catch it.

**Platform note.** On Claude Code (local CLI) the call goes through
after the curator's first WebFetch permission prompt — and this repo
ships a `.claude/settings.json` rule for `eutils.ncbi.nlm.nih.gov` so
even that prompt is skipped. On **claude.ai (browser)** the skill runs
inside a sandbox with a hard network allowlist that does not include
NCBI by default; the curator can lift this by adding
`eutils.ncbi.nlm.nih.gov` to the **Domain allowlist** in claude.ai
Settings → Capabilities. (Earlier hosts — `www.ncbi.nlm.nih.gov` and
`pmc.ncbi.nlm.nih.gov` — were tried for the older idconv endpoint;
neither is the right host for this skill any more. Use
`eutils.ncbi.nlm.nih.gov`.) Without the allowlist entry, the calls fail
— and the absolute no-fabrication rule above applies: every DOI-bearing
ref falls through to the `https://doi.org/...` rung. Do **not** substitute
training-corpus PMIDs. The CSV simply contains more DOI links and fewer
PubMed links than it would when the calls succeed, and that is the
correct behaviour.

**4. Walk the ladder for each reaction's Source slots (no network).** For
every reaction:

 - Take its cited refs.
 - Sort by ref-type priority: primary research → meta-analysis →
   review/editorial/commentary.
 - Within type, prefer newer over older when they make the same point.
 - Take the top 5; drop any 6th and beyond silently.
 - For each kept ref, walk the URL ladder and emit the first non-empty
   URL into the next Source slot:
     PubMed (`https://pubmed.ncbi.nlm.nih.gov/<PMID>/`) →
     PMC (`https://www.ncbi.nlm.nih.gov/pmc/articles/PMC<id>/`) →
     DOI (`https://doi.org/<doi>`) →
     publisher URL (only if printed inline) →
     blank.

`Source1` is the most direct primary research paper for the step. The
originating review PDFs go in the `Reviews` column, never in Source.

## Writing the CSV

 - Column order:
   `Title,Input,Output,Catalyst,Regulators,Reviews,Source1,Source2,Source3,Source4,Source5`
 - Always emit all eleven columns in every row, even when trailing cells
   are empty (so subtitle and gap rows look like
   `## Canonical arm,,,,,,,,,,`).
 - **Reviews cell.** Pipe-delimited PDF basenames with spaces around the
   pipe, e.g. `Smith2024.pdf | Jones2023.pdf`. Each filename must match a
   supplied PDF's basename. No paths, no figure refs, no notes.
 - **Source cells.** Each cell holds exactly one URL or is empty. Apply a
   pre-write URL-shape check: every non-empty Source cell must start with
   `http://` or `https://` and contain no whitespace. Cells that fail are
   blanked silently — never fabricate identifiers, the empty rung is a
   legitimate outcome.
 - One URL per Source cell. Never combine multiple URLs with `;`, commas,
   or any other separator.
 - Filename: slugify the pathway name (lowercase, non-alphanumerics →
   single hyphen, trim leading/trailing hyphens) and write to
   `<pathway-slug>_reactions.csv` in the current working directory.
   Example: "Classical Complement Activation" →
   `classical-complement-activation_reactions.csv`.
 - RFC 4180 quoting: wrap any field containing a comma, double quote, or
   newline in double quotes; escape embedded double quotes by doubling them.
   The pipe `|` does not require quoting on its own.
 - UTF-8 encoding, LF line endings, no BOM, no trailing blank line.

## Writing the References HTML

Alongside the CSV, write `<pathway-slug>_references.html` listing every
unique entry in `seen_refs`.

 - Single `<ul>`, one `<li>` per unique ref.
 - href chosen by the same ladder as the Source columns (PubMed > PMC >
   DOI > publisher URL). If none of the four is available, render the
   entry as plain text with no `<a>`.
 - Link text format: `Authors (Year). Title. Journal.` Any of these
   pieces may be missing; just join what you have.
 - After the link, append `(seen in: <pdf basenames>)` separated by
   commas, for curator audit.
 - Order entries by first-author last name, then year.
 - Minimal `<head>` with `<title>` and a small inline CSS reset; no
   external assets, no JavaScript.

## After Writing

Report to the curator, briefly:

 - The absolute paths to the CSV and the HTML.
 - Counts: total reactions, parallel branches (subtitle rows), inferred
   transport reactions, reversible pairs, and gap markers (parenthesized
   entities or inferred bridging reactions).
 - Reference counts: total unique refs in the HTML; Source cells filled
   vs. left blank; and a breakdown of filled Source cells by ladder rung
   (PubMed / PMC / DOI / publisher).
 - **PubMed-source breakdown.** Of the PubMed URLs in the CSV, report how
   many came from each `pmid_source`:
   `inline:<pdf>` (printed in a PDF), `esearch:doi` (DOI batch
   resolution, step 3a/3b), and `esearch:title-author` (single-match
   per-ref ESearch, step 3c). These three numbers must sum to the total
   PubMed URL count. If both `esearch:*` numbers are 0, state explicitly
   that the network calls failed or returned no usable matches — and
   confirm that no PMID was sourced from anywhere else. This is the
   tripwire for accidental fabrication.
 - The E-utilities outcomes:
   - DOI batch (3a/3b): `succeeded (N of M DOIs resolved)`,
     `ESearch succeeded but ESummary failed (HTTP <code>)`,
     `ESearch failed (HTTP <code>)`,
     `failed (network blocked / domain not in allowlist)`, or
     `not attempted (no DOIs needed resolution)`.
   - Title+author fallback (3c): `attempted N refs, K resolved (single
     match), L ambiguous (>1 match), M no match, P call failures`. If
     not attempted (no refs needed it), say so.
 - Any pathway segments where the evidence was thin or where you resolved a
   conflict between PDFs by taking the most recent.
 - Any place you inferred a transport reaction with an unknown transporter.
 - A short list of the most important gaps, so the curator can decide which
   to chase down in the primary literature.

## Example Rows

Illustrative only — do not copy verbatim.

 Title,Input,Output,Catalyst,Regulators,Reviews,Source1,Source2,Source3,Source4,Source5
 ## Canonical arm,,,,,,,,,,
 Hexokinase phosphorylates glucose,glucose [cytosol] | ATP [cytosol],glucose-6-phosphate [cytosol] | ADP [cytosol],hexokinase [cytosol],- glucose-6-phosphate [cytosol],Smith2024.pdf,https://pubmed.ncbi.nlm.nih.gov/12345678/,https://pubmed.ncbi.nlm.nih.gov/23456789/,https://doi.org/10.1234/example,,
 "(Unknown step: F6P → F1,6BP)","(fructose-6-phosphate [cytosol])","(fructose-1,6-bisphosphate [cytosol])",,,Smith2024.pdf,,,,,
 Translocation of pyruvate from cytosol to mitochondrial matrix (transporter unknown),pyruvate [cytosol],pyruvate [mitochondrial matrix],,,Smith2024.pdf | Jones2023.pdf,,,,,
 ## Alternative arm,,,,,,,,,,
 Glucose-6-phosphate dehydrogenase oxidises G6P,glucose-6-phosphate [cytosol] | NADP+ [cytosol],6-phosphogluconolactone [cytosol] | NADPH [cytosol],glucose-6-phosphate dehydrogenase [cytosol],,Jones2023.pdf,https://pubmed.ncbi.nlm.nih.gov/34567890/,,,,
