// Long-term memory: the chat is summarized in chapters, plus a short list of lasting facts.
// Everything fits in the prompt while the story is short; once it doesn't, the chapters
// that share words with what is happening now are the ones kept.

const STOP = new Set(('the a an and or but if then so of to in on at for with from by as is are was were be been being it its this that these those he she ' +
    'they them his her their you your i me my we our not no yes do does did have has had will would can could should just very into out up down over ' +
    'about what when where who how why which there here than too also more most some any all one two again still back only even like').split(' '));

/** Lowercase content words of a text. */
export function words(text) {
    const out = new Set();
    for (const w of String(text ?? '').toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []) {
        if (!STOP.has(w)) out.add(w);
    }
    return out;
}

export function emptyMemory() {
    return { chapters: [], facts: [], through: -1 };
}

/** Make sure a stored memory object has the right shape. */
export function normalizeMemory(raw) {
    const m = raw && typeof raw === 'object' ? raw : {};
    const chapters = (Array.isArray(m.chapters) ? m.chapters : [])
        .filter(c => c && Number.isInteger(c.from) && Number.isInteger(c.to) && c.summary)
        .map(c => ({ from: c.from, to: c.to, summary: String(c.summary), keywords: Array.isArray(c.keywords) ? c.keywords.map(String) : [] }));
    const facts = (Array.isArray(m.facts) ? m.facts : []).map(f => String(f).trim()).filter(Boolean);
    const lastChapter = chapters.length ? chapters[chapters.length - 1].to : -1;
    const through = Math.max(lastChapter, Number.isInteger(m.through) ? m.through : -1);
    return { chapters, facts, through };
}

/**
 * Which messages should be summarized next, if any.
 * The newest `keepRecent` messages are left alone: they are still being played with.
 * @returns {{from:number, to:number}|null}
 */
export function dueRange({ chatLength, through, interval, keepRecent, maxChunk = 40 }) {
    const lastEligible = chatLength - 1 - keepRecent;
    const from = through + 1;
    if (lastEligible - from + 1 < interval) return null;
    return { from, to: Math.min(lastEligible, from + maxChunk - 1) };
}

/** Forget chapters that cover message `index` or later (after an edit or a delete). */
export function dropFrom(memory, index) {
    memory.chapters = memory.chapters.filter(c => c.to < index);
    memory.through = memory.chapters.length ? memory.chapters[memory.chapters.length - 1].to : -1;
    return memory;
}

/**
 * Pick the chapters to show. All of them when they fit; otherwise the newest one plus
 * the ones that share the most words with the recent messages, in story order.
 */
export function selectChapters(chapters, recentText, budgetChars) {
    const total = chapters.reduce((n, c) => n + c.summary.length, 0);
    if (total <= budgetChars) return chapters.slice();
    const now = words(recentText);
    const scored = chapters.map((c, i) => {
        const pool = new Set([...words(c.summary), ...c.keywords.map(k => k.toLowerCase())]);
        let overlap = 0;
        for (const w of now) if (pool.has(w)) overlap++;
        return { c, i, score: overlap + (i === chapters.length - 1 ? 1000 : 0) + i / (chapters.length * 10) };
    });
    scored.sort((a, b) => b.score - a.score);
    const picked = [];
    let used = 0;
    for (const s of scored) {
        if (used + s.c.summary.length > budgetChars && picked.length) continue;
        picked.push(s);
        used += s.c.summary.length;
    }
    return picked.sort((a, b) => a.i - b.i).map(s => s.c);
}

/** The memory note the local model reads. Empty string when there is nothing to say yet. */
export function renderMemory(memory, recentText, budgetChars) {
    const facts = memory.facts.slice(0, 24);
    const chapters = selectChapters(memory.chapters, recentText, budgetChars);
    if (!facts.length && !chapters.length) return '';
    const lines = ['[Memory of this story. All of this already happened and stays true.]'];
    if (facts.length) {
        lines.push('Lasting facts:');
        for (const f of facts) lines.push(`- ${f}`);
    }
    if (chapters.length) {
        lines.push(chapters.length < memory.chapters.length ? 'Earlier in the story (the parts that matter now):' : 'Earlier in the story:');
        for (const c of chapters) lines.push(`- ${c.summary}`);
    }
    return lines.join('\n');
}
