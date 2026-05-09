// This file is obsolete and slated for deletion.
//
// `resolveByDoi` and `resolveByTitleAuthor` have moved behind the
// production NcbiPort adapter at
// `src/sidepanel/services/refResolver/adapters/ncbiHttp.ts`. The
// reference-resolution pipeline now lives in
// `src/sidepanel/services/refResolver/`, with strategy chain, shared
// rate-limit budget, and event stream.
//
// Delete this file (`git rm src/sidepanel/services/ncbi.ts`) once you
// confirm there are no stale tooling caches or imports.
export {};
