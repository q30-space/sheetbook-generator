import JSZip from "jszip";
import { promises as fs } from "fs";
import path from "path";
import { CanonicalInstrument, classifyOdsRowLabel } from "ror-sheetbook-common";

export interface FilterResult {
    /** Number of instrument rows that survived the filter (after the user's selection). */
    keptInstrumentRows: number;
    /** Number of break/section rows present (always kept). */
    keptBreakRows: number;
    /** Column-A labels we couldn't classify; useful for catching new instrument variants. */
    unknownLabels: string[];
    /** True if the file was copied through unchanged (reference content with no instrument structure). */
    passedThrough?: boolean;
}

/**
 * Filenames of special reference ODS files that hold break/sign content rather than
 * per-instrument sheet rows. We never filter these — column A is descriptive text,
 * not instrument labels, so the row classifier would drop them entirely.
 */
const PASS_THROUGH_FILENAMES = new Set(['breaks.ods', 'breaks_large.ods', 'dances.ods']);

/**
 * Read an ODS, delete the table-rows whose first cell labels an instrument that
 * isn't in `selected`, and write the result. Rows that follow a deleted instrument
 * row and have no first-cell text (continuation rows like "Tamborim 2", visual
 * spacers) are deleted along with it so the spreadsheet compacts cleanly.
 *
 * Header rows, the tune title, beat-number rows, and break sections (Intro, Outro,
 * Call Break, Break N) are always kept regardless of selection.
 *
 * If the input is the special `breaks.ods` file, it is copied through unchanged.
 */
export async function filterOdsByInstruments(
    inputOdsPath: string,
    outputOdsPath: string,
    selected: Set<CanonicalInstrument>
): Promise<FilterResult> {
    if (PASS_THROUGH_FILENAMES.has(path.basename(inputOdsPath))) {
        await fs.copyFile(inputOdsPath, outputOdsPath);
        return { keptInstrumentRows: 0, keptBreakRows: 0, unknownLabels: [], passedThrough: true };
    }

    const data = await fs.readFile(inputOdsPath);
    const zip = await JSZip.loadAsync(data);

    const contentXml = await zip.file('content.xml')!.async('string');
    const { xml: filteredXml, ...result } = filterContentXml(contentXml, selected);

    // Rebuild the zip preserving original file ordering, with mimetype first and STORE-compressed
    // (per the OpenDocument packaging spec).
    const newZip = new JSZip();
    const mimetype = await zip.file('mimetype')?.async('string');
    if (mimetype !== undefined) {
        newZip.file('mimetype', mimetype, { compression: 'STORE' });
    }
    for (const [entryPath, entry] of Object.entries(zip.files)) {
        if (entryPath === 'mimetype') continue;
        if (entry.dir) {
            newZip.folder(entryPath);
            continue;
        }
        const content = entryPath === 'content.xml'
            ? filteredXml
            : await entry.async('nodebuffer');
        newZip.file(entryPath, content);
    }

    const out = await newZip.generateAsync({ type: 'nodebuffer' });
    await fs.writeFile(outputOdsPath, out);

    return result;
}

const ROW_RE = /<table:table-row\b[^>]*>[\s\S]*?<\/table:table-row>|<table:table-row\b[^>]*\/>/g;
// Matches the FIRST cell element (table-cell or covered-table-cell) inside a row.
const FIRST_CELL_RE = /<(table:table-cell|table:covered-table-cell)\b[^>]*(?:\/>|>([\s\S]*?)<\/\1>)/;
const FIRST_TEXT_RE = /<text:p\b[^>]*>([\s\S]*?)<\/text:p>/;
const XML_ENTITY_RE = /&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g;

function decodeEntities(text: string): string {
    return text.replace(XML_ENTITY_RE, (_, entity) => {
        switch (entity) {
            case 'amp':  return '&';
            case 'lt':   return '<';
            case 'gt':   return '>';
            case 'quot': return '"';
            case 'apos': return "'";
            default:
                if (entity.startsWith('#x')) return String.fromCodePoint(parseInt(entity.slice(2), 16));
                if (entity.startsWith('#'))  return String.fromCodePoint(parseInt(entity.slice(1), 10));
                return _;
        }
    });
}

function firstCellText(rowXml: string): string {
    const cellMatch = rowXml.match(FIRST_CELL_RE);
    if (!cellMatch || cellMatch[2] === undefined) {
        return '';
    }
    const textMatch = cellMatch[2].match(FIRST_TEXT_RE);
    if (!textMatch) {
        return '';
    }
    // Strip nested XML elements like <text:s/> (space) and <text:tab/> (tab) before
    // decoding entities, so labels like "Tamborim <text:s/>" classify as "Tamborim".
    const stripped = textMatch[1].replace(/<[^>]+>/g, '');
    return decodeEntities(stripped);
}

interface FilterXmlResult extends FilterResult {
    xml: string;
}

export function filterContentXml(xml: string, selected: Set<CanonicalInstrument>): FilterXmlResult {
    const rowMatches: Array<{ start: number; end: number; xml: string }> = [];
    for (const m of xml.matchAll(ROW_RE)) {
        rowMatches.push({ start: m.index!, end: m.index! + m[0].length, xml: m[0] });
    }

    // First pass: classify each row by its column-A label.
    const classifications = rowMatches.map((row) => {
        const label = firstCellText(row.xml);
        return { label, classification: classifyOdsRowLabel(label) };
    });

    // Second pass: decide deletions. When an instrument row is deleted, also delete
    // following rows whose column A is empty (continuation sub-rows + visual spacer).
    const deleted = new Array<boolean>(rowMatches.length).fill(false);
    let keptInstrumentRows = 0;
    let keptBreakRows = 0;
    const unknownLabels = new Set<string>();

    for (let i = 0; i < classifications.length; i++) {
        if (deleted[i]) continue;
        const { label, classification } = classifications[i];
        if (classification.type === 'instrument') {
            const keep = classification.canonical.some((inst) => selected.has(inst));
            if (keep) {
                keptInstrumentRows++;
            } else {
                deleted[i] = true;
                for (let j = i + 1; j < classifications.length; j++) {
                    if (classifications[j].label.trim().length > 0) break;
                    deleted[j] = true;
                }
            }
        } else if (classification.type === 'break') {
            keptBreakRows++;
        } else if (label.trim().length > 0) {
            // Non-empty labels we couldn't classify — track for diagnostics.
            // Skip canonical-instrument label lookups (they classify successfully) and
            // skip pure-numeric / single-character cells (beat numbers, etc).
            if (!/^[0-9.]+$/.test(label.trim())) {
                unknownLabels.add(label.trim());
            }
        }
    }

    // Third pass: splice deleted rows out of the original XML, preserving everything else.
    let result = '';
    let cursor = 0;
    for (let i = 0; i < rowMatches.length; i++) {
        if (deleted[i]) {
            result += xml.slice(cursor, rowMatches[i].start);
            cursor = rowMatches[i].end;
        }
    }
    result += xml.slice(cursor);

    return {
        xml: result,
        keptInstrumentRows,
        keptBreakRows,
        unknownLabels: [...unknownLabels]
    };
}
