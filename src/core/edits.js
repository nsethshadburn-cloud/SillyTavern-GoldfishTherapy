// Apply Claude's corrections to a reply: exact find/replace, nothing fuzzy.
// An edit whose text isn't found is skipped and reported, never guessed at.

const MIN_KEPT = 0.25; // an edit set that removes more than three quarters of the reply is refused

/**
 * @param {string} text the reply
 * @param {Array<{find:string, replace?:string, why?:string}>} edits
 * @returns {{text:string, applied:Array<{find:string, replace:string, why:string}>, skipped:Array<{find:string, reason:string}>}}
 */
export function applyEdits(text, edits) {
    const original = String(text ?? '');
    let out = original;
    const applied = [];
    const skipped = [];
    for (const edit of Array.isArray(edits) ? edits : []) {
        const find = String(edit?.find ?? '');
        const replace = String(edit?.replace ?? '');
        const why = String(edit?.why ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
        if (!find.trim()) continue;
        if (find === replace) continue;
        const at = locate(out, find);
        if (!at) {
            skipped.push({ find, reason: 'text not found in the reply' });
            continue;
        }
        out = out.slice(0, at.start) + replace + out.slice(at.end);
        applied.push({ find: at.found, replace, why });
    }
    if (!applied.length) return { text: original, applied, skipped };
    out = tidy(out);
    if (!out || out.length < original.length * MIN_KEPT) {
        return {
            text: original,
            applied: [],
            skipped: [...skipped, ...applied.map(e => ({ find: e.find, reason: 'the edits would have removed most of the reply' }))],
        };
    }
    return { text: out, applied, skipped };
}

/** Exact match first; then the same text with any run of whitespace treated as equal. */
function locate(text, find) {
    const exact = text.indexOf(find);
    if (exact !== -1) return { start: exact, end: exact + find.length, found: find };
    const pattern = find.trim().split(/\s+/).map(escapeRegex).join('\\s+');
    const match = new RegExp(pattern).exec(text);
    return match ? { start: match.index, end: match.index + match[0].length, found: match[0] } : null;
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Clean up what a cut leaves behind: empty emphasis, doubled spaces, stranded punctuation. */
export function tidy(text) {
    return String(text)
        .replace(/\*[ \t]*\*/g, '')            // "**" or "* *" left by cutting a whole action
        .replace(/"[ \t]*"/g, '')              // an emptied quote
        .replace(/[ \t]+([,.;:!?])/g, '$1')    // space before punctuation
        .replace(/([,;:])[ \t]*([.!?])/g, '$2') // ", ." becomes "."
        .replace(/\([ \t]*\)/g, '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/^[ \t]+|[ \t]+$/gm, '')
        .replace(/^[,.;:—–-]+[ \t]*$/gm, '')   // a line that is only punctuation
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
