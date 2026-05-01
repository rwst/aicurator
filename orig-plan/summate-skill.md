---
name: draft-summation
description: Draft a Reactome-style reaction summation from a pasted Google Sheet row plus the local PDFs of the cited PubMed references. The curator pastes one tab-separated row (Title, empty summation column, Inputs, Outputs, Catalyst, Regulators, then PubMed URLs) and supplies the project directory; the skill matches each PMID to a `PMID-<id>_*.pdf` file under `<project>/PDF/`, reads the cited PDFs, and synthesises a Reactome-style summation with inline `(Author et al. YEAR)` citations following the rules in `summation-style.md` (distilled from Curator Guide V94). The skill prints the summation as a copy-ready text block — the curator does what they like with it. Use after `extract-reactions` has built the row and `pmid-tagger` (or manual download) has populated the PDF directory.
---

# Draft Summation Skill

## Purpose

Given (a) one row from a Reactome reaction sheet and (b) the project's
local PDF directory, produce a Reactome-style summation paragraph with
inline citations. The curator pastes the row, the skill drafts the
summation, the curator copies the printed text.

The skill does not modify the sheet or any project file. The only
file it touches is a tiny last-project cache under `~/.config/`
(see *Required Inputs*).

## Required Inputs

Ask the curator for, and do not proceed until you have both:

 1. **Project directory.** Absolute path to the project folder
    containing a `PDF/` subdirectory whose files follow the
    `PMID-<id>_<original>.pdf` naming convention (the `pmid-tagger`
    Chrome extension or the equivalent manual rename).

    The skill caches the most recently used project directory at
    `~/.config/reactome-curator-workflows/draft-summation.json` (a
    small JSON file with one key, `last_project`). On every run
    after the first, offer the cached value as the default:

    > "Default project: `<cached-path>` (from last run). Press
    > enter to reuse, or supply a different path."

    Empty input ⇒ reuse the cached value. Any non-empty input ⇒
    use that and update the cache. If the cache file is missing,
    ask without offering a default. If the cached path no longer
    exists on disk, warn, ignore the cached value, and ask afresh.

 2. **Row text.** The single row, copied from the sheet and pasted
    into the conversation. Tab-separated cells; trailing tabs and
    empty cells are tolerated.

The sheet URL and row number are not collected — the skill operates
entirely on the pasted row and the local PDF directory.

## Invocation

 /draft-summation

No arguments. The skill prompts for the two inputs.

## Row Schema

Cells in fixed order, tab-separated:

| Col | Meaning | Notes |
|---|---|---|
| A | Title | Free text. Becomes the reaction's `name`. Don't paraphrase it in the summation. |
| B | Summation | Empty for a new draft. If non-empty, see *Existing Summation* below. |
| C | Inputs | Pipe-delimited, e.g. `LANA oligomer:HHV8 ori-P [nucleoplasm] \| ORC complex [nucleoplasm]`. Spaces around `\|`. |
| D | Outputs | Pipe-delimited, same format. |
| E | Catalyst | Single entity or empty. |
| F | Regulators | Pipe-delimited with `+` / `-` prefixes, e.g. `+ AMP [cytosol] \| - ATP [cytosol]`, or empty. |
| G…| PubMed URLs | Each cell holds one full URL `https://pubmed.ncbi.nlm.nih.gov/<PMID>/`. Empty cells between URLs and trailing empties are tolerated. |

**Parser rules:**

- Split the pasted row on `\t` (tab). If splitting on tab produces
  fewer than 7 cells, fall back to splitting on runs of ≥4 spaces and
  warn the curator that the paste may have had whitespace
  normalisation; offer to abort.
- Strip leading and trailing whitespace from each cell.
- Trailing empty cells are dropped before counting.
- PubMed URLs are extracted by matching
  `https?://pubmed\.ncbi\.nlm\.nih\.gov/(\d+)/?` against cells G
  onward. Bare PMIDs in those cells are also accepted (digits only).
- PMIDs are deduplicated, preserving first-seen order.

## Locating the PDFs

For each PMID:

 1. Look in `<project>/PDF/` for files matching the glob
    `PMID-<PMID>_*.pdf`.
 2. If exactly one match: use it.
 3. If multiple matches: list them and use the **first** by filename
    sort. Warn the curator.
 4. If zero matches: record the PMID as missing. Do not abort the
    run unless ALL PMIDs are missing.

Report all missing PMIDs to the curator before drafting. A draft from
a partial PDF set is acceptable; a draft from zero PDFs is not — stop
and ask the curator to populate the PDF directory.

## Reading the PDFs

Use the `Read` tool, which handles `.pdf` natively.

- For PDFs ≤10 pages: read in full.
- For PDFs >10 pages: read in pages 1–10 first (covers
  abstract/introduction/methods/early results), then issue additional
  page-range reads only if those sections did not contain the
  reaction-relevant evidence (e.g. the input/output entity is
  mentioned only in a later figure).
- Capture for each PDF: first author's surname, year, journal/title,
  the experimental evidence relevant to this reaction (1–2 sentences
  worth), and any caveats (cell type, species, in-vitro vs in-vivo).

The skill reads PDFs to gather evidence, not to summarise the papers.
Stay focused on what supports the specific input → output transition
described by the row.

## Drafting the Summation

Read `@summation-style.md` before composing the draft. That file
captures the V94 rules and the Reactome conventions on length, voice,
tense, citation format, and what to include or omit.

Workflow:

 1. Identify the assertion(s) the row implies — typically one or
    two: the binding/transport/catalysis itself, plus regulation if
    Regulators is non-empty.
 2. Map each assertion to one or more cited PDFs that support it.
 3. Compose 1–4 sentences that walk the assertion(s) in mechanistic
    order, with `(LastName et al. YEAR)` citations attached to each
    claim.
 4. Verify every sentence carries at least one citation. A sentence
    with no citation is a bug — split, merge, or revise.
 5. Verify no claim goes beyond what the cited PDFs themselves state.
 6. Verify tense and voice rules from `summation-style.md`.
 7. If a PMID is missing a PDF, do **not** cite that author/year
    purely from the title or your knowledge — the citation is only
    valid if you have the paper text. Note the missing reference at
    the end of the chat output, separately from the summation.

## Approval Loop

Before declaring done, present:

 - The proposed summation, in a `markdown` code block, ready to
   paste.
 - The list of cited papers used (PMID → first-author + year),
   alongside any PMIDs that were *supplied but not cited* (because no
   PDF, or because not relevant to the assertion).
 - The list of supplied PMIDs whose PDFs were missing.

Then ask the curator: **"Approve this summation, or revise?"**.

 - On *approve*: print the summation again as a final
   plain-text block (no markdown fences) so the curator can copy it.
   Stop.
 - On *revise*: take the curator's specific instructions ("shorten",
   "drop the regulator sentence", "use Verma 2007 instead of 2006"),
   re-draft, and loop.

## Existing Summation

If the curator volunteers that there is already a draft summation
for this reaction:

 - Default behaviour is to **stop and ask**: "There's already a
   draft. Replace, refine, or skip?"
 - On *replace*: proceed as normal; print the new summation.
 - On *refine*: ask the curator to paste the existing summation
   alongside the row, and treat it as a starting point — preserve
   citations the curator likely vetted, replace or extend prose only
   where the new evidence supports it.
 - On *skip*: stop without drafting.

## Failure Modes

| Condition | Behaviour |
|---|---|
| Pasted row has <7 cells after tab split, even with ≥4-space fallback | Stop. Ask the curator to re-paste with tabs preserved. |
| Title cell empty | Stop. A reaction with no title cannot be drafted. |
| No PubMed URLs / PMIDs found | Stop. There is nothing to cite. |
| All PMIDs missing PDFs | Stop. Ask the curator to populate `<project>/PDF/` first (point at `pmid-tagger` or `/extract-reactions`). |
| Some PMIDs missing PDFs | Warn, proceed with partial set. |
| A PDF read returns garbage (image-only, encrypted) | Skip that paper, warn, continue with the rest. |
| Inputs cell empty | Warn; the summation cannot describe what the reaction does to nothing — ask the curator to confirm before proceeding. |
| Outputs cell empty | Same as Inputs. |
| Catalyst named in row but no cited paper supports the catalysis | Mention the catalyst by name without making a mechanistic claim about its activity, OR ask the curator to add a paper. |
| Reaction is in a disease pathway and curator hasn't said so | Ask once whether to apply disease-pathway conventions (V94 §10). |

## Output Format

The summation is plain prose. No headings, no bullet points, no
"Summation:" prefix. The curator copies the printed text and
uses it however they wish.

Internal newlines in the prose are fine, but the entire summation
should remain a single Reactome `summation` slot's worth of text — by
convention one paragraph.

## What This Skill Is Not

 - Not a sheet read/write tool. Output is text only.
 - Not a citation lookup tool. PMIDs come from the row; the skill
   reads the corresponding local PDFs and never resolves PMIDs from
   any other source.
 - Not a curator's substitute for V94. When the case is ambiguous —
   disease pathway, weak evidence, inference from another species —
   the skill flags the ambiguity and asks rather than guessing.

## Recommended `.claude/settings.json` Allow-list

Once you've used the skill once, run `/fewer-permission-prompts` to
populate the project allow-list. Tools the skill exercises:

 - `Read` (for the local PDFs).
 - `Bash(ls:*)` and `Bash(find:*)` (locating PDFs by PMID glob).

That's the full surface — no Chrome MCP, no network calls, and the
only file written is the small last-project cache mentioned above.
