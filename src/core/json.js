// Pull one JSON object out of a model reply that may have words or code fences around it.

/**
 * @param {string} text
 * @returns {object|null} the first complete JSON object found, or null
 */
export function extractJson(text) {
    const s = String(text ?? '');
    for (let start = s.indexOf('{'); start !== -1; start = s.indexOf('{', start + 1)) {
        const end = matchingBrace(s, start);
        if (end === -1) continue;
        try {
            const value = JSON.parse(s.slice(start, end + 1));
            if (value && typeof value === 'object' && !Array.isArray(value)) return value;
        } catch { /* not JSON from this brace; try the next one */ }
    }
    return null;
}

/** Index of the brace that closes the one at `start`, skipping braces inside strings. */
function matchingBrace(s, start) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < s.length; i++) {
        const c = s[i];
        if (inString) {
            if (c === '\\') i++;
            else if (c === '"') inString = false;
            continue;
        }
        if (c === '"') inString = true;
        else if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}
