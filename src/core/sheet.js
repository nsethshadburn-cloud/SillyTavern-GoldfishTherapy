// The scene sheet: a small, exact record of the physical state of the scene.
// Claude writes it as JSON; the local model reads it as a short note.

const MAX_PEOPLE = 8;
const MAX_LIST = 8;
const MAX_THINGS = 12;
const MAX_RECENT = 4;
const MAX_ITEM = 180;

const PERSON_LISTS = ['restraints', 'wearing', 'holding', 'condition'];

function clean(value, max = MAX_ITEM) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanList(value, maxItems) {
    const list = Array.isArray(value) ? value : (value ? [value] : []);
    const out = [];
    for (const item of list) {
        const text = clean(typeof item === 'object' && item ? Object.values(item).join(' ') : item);
        if (text && !/^(none|nothing|n\/a|unknown)\.?$/i.test(text) && !out.includes(text)) out.push(text);
        if (out.length >= maxItems) break;
    }
    return out;
}

/**
 * Turn whatever the model sent into a well-formed sheet.
 * @returns {object|null} null when there is nothing usable
 */
export function normalizeSheet(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const sheet = {
        place: clean(raw.place),
        time: clean(raw.time),
        world: clean(raw.world, 240),
        people: {},
        things: cleanList(raw.things, MAX_THINGS),
        recent: cleanList(raw.recent, MAX_RECENT),
    };
    const people = raw.people && typeof raw.people === 'object' && !Array.isArray(raw.people) ? raw.people : {};
    for (const [name, value] of Object.entries(people)) {
        const key = clean(name, 60);
        if (!key || !value || typeof value !== 'object') continue;
        const person = { position: clean(value.position) };
        for (const list of PERSON_LISTS) person[list] = cleanList(value[list], MAX_LIST);
        sheet.people[key] = person;
        if (Object.keys(sheet.people).length >= MAX_PEOPLE) break;
    }
    const empty = !sheet.place && !sheet.time && !Object.keys(sheet.people).length && !sheet.things.length;
    return empty ? null : sheet;
}

const or = (list, none) => (list.length ? list.join('; ') : none);

/**
 * The note the local model reads. Empty lists are spelled out ("Restraints: none")
 * because a model that isn't told someone is free tends to assume they are not.
 */
export function renderSheet(stored, { stale = false } = {}) {
    const sheet = normalizeSheet(stored); // stored sheets may come from an older version
    if (!sheet) return '';
    const lines = [stale
        ? '[Scene facts as of just before the newest message. Where the newest message changes one of them, the newest message wins. Everything else still holds.]'
        : '[Scene facts. These are true right now. Whatever is written next must fit them.]'];
    if (sheet.place) lines.push(`Place: ${sheet.place}`);
    if (sheet.time) lines.push(`Time: ${sheet.time}`);
    if (sheet.world) lines.push(`World: ${sheet.world}`);
    for (const [name, p] of Object.entries(sheet.people)) {
        const parts = [];
        if (p.position) parts.push(`Position: ${p.position}.`);
        parts.push(`Restraints: ${or(p.restraints, 'none, free to move')}.`);
        if (p.wearing.length) parts.push(`Wearing: ${p.wearing.join('; ')}.`);
        parts.push(`Holding: ${or(p.holding, 'nothing')}.`);
        if (p.condition.length) parts.push(`Condition: ${p.condition.join('; ')}.`);
        lines.push(`${name}: ${parts.join(' ')}`);
    }
    if (sheet.things.length) lines.push(`Things here: ${sheet.things.join('; ')}`);
    if (sheet.recent.length) lines.push(`Just changed: ${sheet.recent.join('; ')}`);
    lines.push('[Do not add objects, restraints or injuries that are not listed here or already in the story.]');
    return lines.join('\n');
}

export function sameSheet(a, b) {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
