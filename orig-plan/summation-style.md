# Reactome Reaction Summation — Style Rules

This file distils the Reactome-summation principles from
`Curator_Guide_V94.pdf` plus established Reactome conventions, scoped to
**reaction-level** summations (not pathway-level). Read in full before
drafting.

## Hard rules from V94

1. **Every assertion must be backed by a citation.** A summation that
   contains an unsupported claim is an error. The citation points the
   reviewer to the paper that proves the statement and signals the
   claim is established fact, not curator opinion or finding
   *(V94 §1, "any time you make a statement in your summation you
   should include a reference")*.

2. **Direct experimental evidence in the annotated species is the
   default.** For human reactions, the cited papers must demonstrate
   the reaction in human or human-derived material *(V94 §6, "Principles
   for Assigning Literature References for Reactions")*. If the only
   evidence is from another species, the reaction is an *inferred*
   event and the summation must explicitly say so and explain the
   basis for the inference.

3. **Weaker evidence requires explicit rationale.** Reactions added
   without direct experimental evidence (typically transport with
   unknown transporter, or enzymatic step with unknown enzyme) MUST
   carry rationale in the summation explaining why it was added
   despite the weaker evidence *(V94 §6, "Other evidence types")*.

4. **High-throughput-only evidence is not enough.** Microarray,
   proteomics, and similar high-throughput observations are
   insufficient on their own unless an expert author has confirmed
   them or a meta-analysis combines independent studies *(V94 §1,
   "Evidence and references")*. Such evidence requires acknowledgement
   in the summation.

5. **No factual claims about the reaction beyond what the cited
   papers support.** Inferences and interpretations the cited authors
   themselves do not make are not allowed. Reactome does not editorialise.

## Reactome conventions (style, not strict V94)

These are not spelled out in V94 but are observed practice across
gk_central. Treat them as defaults; deviate only with reason.

### Length

A typical reaction summation is **one paragraph, 1–4 sentences**,
roughly **40–150 words**. Longer is acceptable for reactions whose
mechanism is complex or where multiple lines of evidence converge.
Shorter (a single sentence) is fine for simple binding or transport
reactions.

### Voice and tense

- **Third person.** No "we", "I", "our".
- **Present tense for the mechanism**: "LANA recruits ORC to ori-P".
- **Past tense for the experimental evidence**: "Stedman *et al.*
  showed that LANA co-immunoprecipitated with ORC subunits".
- **Active voice** is preferred for the mechanism; **passive** is
  acceptable when reporting an experimental observation whose agent is
  not the subject of interest.
- No future tense ("will", "would"), no editorial framing
  ("interestingly", "remarkably", "future work…").

### Inline citations

**Format**: `(LastName et al. YEAR)`, with `et al.` for ≥3 authors;
two-author papers use `(Smith and Jones, YEAR)`; single-author papers
use `(Smith, YEAR)`. Multiple citations in one parenthetical are
separated by semicolons: `(Smith et al. 2024; Jones et al. 2025)`.

Citations attach to the assertion they support, not at end-of-paragraph.

If two papers establish the same point, cite both at that point. Do
not artificially split text to spread citations.

### What to include

For a typical enzyme- or complex-binding reaction:

1. **The reaction itself**, in mechanistic terms — what the inputs do
   to become the outputs, in one clause.
2. **Where it happens** if the compartment is biologically meaningful
   (most reactions in nucleoplasm/cytosol omit this; specialised
   compartments like ER lumen, mitochondrial matrix, viral genome are
   worth naming).
3. **Catalyst's molecular function**, when a catalyst is present —
   what activity it provides (kinase, helicase, etc.). Skip if the
   catalyst is named explicitly and its function is obvious from the
   name.
4. **Key supporting experimental evidence**, in 1–2 phrases:
   "co-immunoprecipitation", "ChIP-seq", "EMSA", "in vitro kinase
   assay". Don't rehearse every paper's methods; mention only the
   evidence that distinguishes this reaction's grounding from generic.
5. **Regulators**, with direction (positive/negative) and at least one
   citation, if any are listed in the row.
6. **Inference rationale** if the human evidence is indirect: "By
   analogy to the well-characterised X mechanism in mouse
   (Author YEAR), the same is presumed to occur in human."

### What to omit

- Drug-target relevance (unless the reaction is in a disease/drug
  pathway).
- Disease association (unless in a disease pathway).
- Statements about "implications" or "importance".
- Restating the reaction title verbatim.
- Reference list within the prose — only inline citations.
- Mentioning the cell type(s) used in the cited experiments unless
  cell-type specificity is the point.
- Compartments already named in the input/output entity strings (no
  need to repeat `[nucleoplasm]` in prose if it's in the inputs).

## Worked example

For a reaction with inputs `LANA oligomer:HHV8 ori-P [nucleoplasm] |
ORC complex [nucleoplasm]`, output `LANA:ORC:HHV8 ori-P
[nucleoplasm]`, no catalyst, no regulators, and four cited papers, an
acceptable summation looks like:

> The latency-associated nuclear antigen (LANA) of HHV-8, bound as an
> oligomer at the viral terminal-repeat origin of replication
> (ori-P), recruits the cellular origin recognition complex (ORC) to
> the viral genome (Stedman et al. 2004; Verma et al. 2006). LANA
> directly contacts ORC2 in vitro (Lim et al. 2002), and the
> interaction is required for ORC loading onto ori-P in latently
> infected cells (Verma et al. 2006). The recruited LANA:ORC complex
> licenses the viral episome for replication during S phase
> (Hu and Renne, 2005).

Note: in real curation the citation surnames must come from the
PubMed records of the supplied PMIDs — never invented or guessed.

## Where to verify uncertain cases

When the V94 rules above don't clearly resolve a case (e.g., a
reaction in a disease pathway, an inference from non-mammalian
evidence, a black-box reaction without direct enzymatic evidence),
fall back to reading the relevant V94 sections directly:

- §1 *Important general guidelines* — evidence and references rules.
- §6 *Providing evidence for assertions* — direct vs indirect
  evidence, evidenceType, citation principles.
- §10 *Disease pathway curation guide* — disease-specific summation
  conventions (failed reactions, gain-of-function annotations,
  rationale wording).
- §11 *Infectious disease and Innate Immune System pathway curation
  guide* — viral and host-pathogen wording conventions.

The full text is in
`/home/ralf/reactome/reactome-curator-workflows/Curator Guide_V94.txt`.
