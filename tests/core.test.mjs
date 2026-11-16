import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJson } from '../src/core/json.js';
import { normalizeSheet, renderSheet } from '../src/core/sheet.js';
import { applyEdits, tidy } from '../src/core/edits.js';
import { dueRange, dropFrom, selectChapters, renderMemory, normalizeMemory } from '../src/core/memory.js';
import { parseGate, buildCheck, buildAdvance } from '../src/core/prompts.js';

test('extractJson finds the object inside chatter and code fences', () => {
    assert.deepEqual(extractJson('Sure!\n```json\n{"a": {"b": "x } y"}}\n```\nDone.'), { a: { b: 'x } y' } });
    assert.equal(extractJson('I cannot help with that.'), null);
    assert.deepEqual(extractJson('{broken} then {"ok": true}'), { ok: true });
});

test('normalizeSheet repairs sloppy input and drops empty words', () => {
    const sheet = normalizeSheet({
        place: '  forest   camp ',
        people: { Mira: { position: 'on a log', restraints: 'wrists tied behind back', holding: ['nothing'], wearing: ['cloak', 'cloak'] } },
        things: [{ item: 'key', where: 'on his belt' }],
    });
    assert.equal(sheet.place, 'forest camp');
    assert.deepEqual(sheet.people.Mira.restraints, ['wrists tied behind back']);
    assert.deepEqual(sheet.people.Mira.holding, []);
    assert.deepEqual(sheet.people.Mira.wearing, ['cloak']);
    assert.deepEqual(sheet.things, ['key on his belt']);
    assert.equal(normalizeSheet({}), null);
    assert.equal(normalizeSheet('nope'), null);
});

test('renderSheet says out loud when someone is free and empty-handed', () => {
    const text = renderSheet(normalizeSheet({ place: 'tent', people: { Mira: { position: 'lying down' } }, recent: ['the collar came off'] }));
    assert.match(text, /Mira: Position: lying down\. Restraints: none, free to move\. Holding: nothing\./);
    assert.match(text, /Just changed: the collar came off/);
    assert.equal(renderSheet(null), '');
});

test('applyEdits replaces exact text and tidies the hole', () => {
    const reply = '*She grips the pencil off the desk, twisting it.* "Fine. I take it."';
    const out = applyEdits(reply, [{ find: '*She grips the pencil off the desk, twisting it.* ', replace: '', why: 'No desk or pencil exists here.' }]);
    assert.equal(out.text, '"Fine. I take it."');
    assert.equal(out.applied.length, 1);
});

test('applyEdits tolerates whitespace differences but never guesses', () => {
    const reply = 'She wipes her mouth\nwith the back of her wrist, glaring.';
    const ok = applyEdits(reply, [{ find: 'wipes her mouth with the back of her wrist', replace: 'wipes her mouth against her shoulder' }]);
    assert.equal(ok.text, 'She wipes her mouth against her shoulder, glaring.');
    const miss = applyEdits(reply, [{ find: 'snatches the collar', replace: '' }]);
    assert.equal(miss.text, reply);
    assert.equal(miss.skipped.length, 1);
});

test('applyEdits refuses to gut a reply', () => {
    const reply = 'She stands up and walks to the door, then opens it and steps outside into the rain.';
    const out = applyEdits(reply, [{ find: 'She stands up and walks to the door, then opens it and steps outside into the', replace: '' }]);
    assert.equal(out.text, reply);
    assert.equal(out.applied.length, 0);
    assert.match(out.skipped[0].reason, /most of the reply/);
});

test('tidy cleans stranded punctuation and empty emphasis', () => {
    assert.equal(tidy('*She nods.* ** "Yes , of course ."'), '*She nods.* "Yes, of course."');
});

test('dueRange waits for a full interval beyond the recent messages', () => {
    assert.equal(dueRange({ chatLength: 17, through: -1, interval: 12, keepRecent: 6 }), null);
    assert.deepEqual(dueRange({ chatLength: 18, through: -1, interval: 12, keepRecent: 6 }), { from: 0, to: 11 });
    assert.deepEqual(dueRange({ chatLength: 200, through: 11, interval: 12, keepRecent: 6 }), { from: 12, to: 51 });
});

test('dropFrom forgets chapters at or after an edited message', () => {
    const memory = normalizeMemory({ chapters: [{ from: 0, to: 11, summary: 'a' }, { from: 12, to: 23, summary: 'b' }], facts: ['x'] });
    assert.equal(memory.through, 23);
    dropFrom(memory, 15);
    assert.equal(memory.chapters.length, 1);
    assert.equal(memory.through, 11);
});

test('selectChapters keeps everything that fits, else the newest plus the relevant', () => {
    const chapters = [
        { from: 0, to: 9, summary: 'Mira stole the brass key from the warden and hid it in her boot. '.repeat(3), keywords: ['key', 'warden'] },
        { from: 10, to: 19, summary: 'They crossed the river on a ferry and argued about money. '.repeat(3), keywords: ['ferry', 'river'] },
        { from: 20, to: 29, summary: 'A storm trapped them in a barn where the cook told a long story. '.repeat(3), keywords: ['storm', 'barn'] },
    ];
    assert.equal(selectChapters(chapters, 'anything', 5000).length, 3);
    const picked = selectChapters(chapters, 'She reaches for the key in her boot.', 420);
    assert.deepEqual(picked.map(c => c.from), [0, 20]);
});

test('renderMemory is empty until there is something to remember', () => {
    assert.equal(renderMemory(normalizeMemory(null), '', 2000), '');
    const text = renderMemory(normalizeMemory({ facts: ['Mira owes the ferryman a favour.'], chapters: [{ from: 0, to: 9, summary: 'They met at the docks.' }] }), '', 2000);
    assert.match(text, /Lasting facts:\n- Mira owes the ferryman a favour\./);
    assert.match(text, /Earlier in the story:\n- They met at the docks\./);
});

test('parseGate says YES unless the answer is clearly NO', () => {
    assert.equal(parseGate('NO'), false);
    assert.equal(parseGate(' no.'), false);
    assert.equal(parseGate('YES'), true);
    assert.equal(parseGate('NO, wait, YES'), false);
    assert.equal(parseGate('<think>hmm'), true);
    assert.equal(parseGate(''), true);
});

test('prompts carry the sheet, the cast and the reply', () => {
    const cast = { charName: 'Mira', userName: 'Tom', card: 'A caravan guide.' };
    const sheet = normalizeSheet({ place: 'camp', people: { Mira: { restraints: ['wrists tied'] } } });
    const check = buildCheck({ cast, sheet, context: [], reply: { index: 4, name: 'Mira', isUser: false, text: 'She waves.' } });
    assert.match(check.system, /continuity editor/);
    assert.match(check.user, /wrists tied/);
    assert.match(check.user, /\[#4 Mira \(character\)\]\nShe waves\./);
    const advance = buildAdvance({ cast, sheet: null, context: [], messages: [{ index: 0, name: 'Tom', isUser: true, text: 'He unties her.' }] });
    assert.match(advance.user, /There is no sheet yet/);
    assert.match(advance.user, /\[#0 Tom \(player\)\]/);
});
