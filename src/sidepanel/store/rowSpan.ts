import { createSignal } from 'solid-js';

// Shared row-span input state across Summate and Canonize. The two tabs
// almost always run on the same set of rows in sequence, so whatever the
// curator picked in Summate carries over as the pre-set in Canonize.
export type SpanMode = 'all' | 'span';

export const [rowSpanMode, setRowSpanMode] = createSignal<SpanMode>('all');
export const [rowSpanText, setRowSpanText] = createSignal('');
