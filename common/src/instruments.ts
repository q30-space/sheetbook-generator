/**
 * Canonical instrument names presented to the user in the frontend filter.
 * Order matches the README's documented sheet ordering.
 */
export const CANONICAL_INSTRUMENTS = [
    'Low Surdo',
    'Mid Surdo',
    'High Surdo',
    'Repinique',
    'Snare',
    'Tamborim',
    'Agogô',
    'Shaker'
] as const;

export type CanonicalInstrument = typeof CANONICAL_INSTRUMENTS[number];

/**
 * Maps a column-A label found in a tune ODS to one or more canonical instruments.
 * Recognises grouped variants ("All Surdos"), combined instruments ("Mid+High Surdo"),
 * and numbered sub-rows ("Tamborim 1") that don't appear in CANONICAL_INSTRUMENTS
 * directly but represent them.
 *
 * Keys are matched case-insensitively (see classifyOdsRowLabel) — the sheetbook
 * isn't perfectly consistent about capitalisation ("High surdo" vs "High Surdo").
 *
 * If you see a tune appearing where you don't expect (an instrument row was kept
 * for an instrument the user didn't select), check the unknownLabels diagnostic
 * from filterOdsByInstruments and add the variant here.
 */
const INSTRUMENT_LABEL_VARIANTS: Record<string, readonly CanonicalInstrument[]> = {
    // Surdo groupings
    'all surdos':            ['Low Surdo', 'Mid Surdo', 'High Surdo'],
    'surdos':                ['Low Surdo', 'Mid Surdo', 'High Surdo'],
    'mid+high surdo':        ['Mid Surdo', 'High Surdo'],
    'mid&high surdo':        ['Mid Surdo', 'High Surdo'],
    'mid & high surdo':      ['Mid Surdo', 'High Surdo'],
    'mid/high surdo':        ['Mid Surdo', 'High Surdo'],
    'low+mid surdo':         ['Low Surdo', 'Mid Surdo'],
    'high surdo + repi':     ['High Surdo', 'Repinique'],

    // Tamborim sub-numbers
    'tamborim 1':            ['Tamborim'],
    'tamborim 2':            ['Tamborim'],

    // Snare sub-numbers and combinations
    'snare 1':               ['Snare'],
    'snare 2':               ['Snare'],
    'snare / repinique':     ['Snare', 'Repinique'],
    'snare 1 / repinique':   ['Snare', 'Repinique'],
    'snare/shakers':         ['Snare', 'Shaker'],
    'snare 2 / shakers':     ['Snare', 'Shaker'],
    'repi & snare':          ['Snare', 'Repinique'],

    // Other variants
    'skipping agogô':        ['Agogô']
};

/**
 * A label matching this regex is treated as a break/section row and is always kept,
 * regardless of the user's instrument selection. Drummers need their breaks even
 * when they've filtered out every instrument row.
 */
export const BREAK_ROW_LABEL_RE = /^(intro|outro|call\s*break|break(\s*\d+)?)$/i;

export type OdsRowClassification =
    | { type: 'instrument'; canonical: readonly CanonicalInstrument[] }
    | { type: 'break' }
    | { type: 'other' };

/**
 * Classify the first-cell text of an ODS row.
 *
 * - Empty/whitespace-only → 'other' (continuation row, spacer, etc. — caller decides).
 * - Matches BREAK_ROW_LABEL_RE → 'break'.
 * - In INSTRUMENT_LABEL_VARIANTS or CANONICAL_INSTRUMENTS → 'instrument' with mapping.
 * - Anything else → 'other' (header, tune title, legend).
 */
// Pre-build a lowercased lookup of canonical instruments for case-insensitive matching.
const CANONICAL_LOWER: Record<string, CanonicalInstrument> = Object.fromEntries(
    CANONICAL_INSTRUMENTS.map((i) => [i.toLowerCase(), i])
);

export function classifyOdsRowLabel(rawLabel: string): OdsRowClassification {
    const label = rawLabel.trim();
    if (label.length === 0) {
        return { type: 'other' };
    }
    if (BREAK_ROW_LABEL_RE.test(label)) {
        return { type: 'break' };
    }
    const lower = label.toLowerCase();
    const variant = INSTRUMENT_LABEL_VARIANTS[lower];
    if (variant) {
        return { type: 'instrument', canonical: variant };
    }
    const canonical = CANONICAL_LOWER[lower];
    if (canonical) {
        return { type: 'instrument', canonical: [canonical] };
    }
    return { type: 'other' };
}
