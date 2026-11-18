// The turn logic played against a fake chat, a fake local model and a fake Claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/core/engine.js';
import { normalizeMemory } from '../src/core/memory.js';

const TIED = { place: 'forest camp', time: 'night', world: 'medieval fantasy', people: { Mira: { position: 'sitting on a log', restraints: ['wrists tied behind her back with rope'] } } };
const FREE = { place: 'forest camp', time: 'night', world: 'medieval fantasy', people: { Mira: { position: 'sitting on a log', restraints: [] } }, recent: ['the rope was cut from her wrists'] };

function user(mes) { return { name: 'Tom', is_user: true, mes, extra: {} }; }
function bot(mes) { return { name: 'Mira', is_user: false, mes, swipe_id: 0, swipes: [mes], extra: {} }; }

function rig({ gate = () => true, claude, settings = {} } = {}) {
    const log = { claude: [], gate: [], inject: [], status: [], persist: [] };
    const state = { chat: [], memory: normalizeMemory(null), id: 'chat-1' };
    const deps = {
        chat: () => state.chat,
        chatId: () => state.id,
        settings: () => ({ enabled: true, gateMode: 'local', timing: 'before', fixReplies: true, interval: 4, keepRecent: 2, memoryBudget: 2000, rebuildWindow: 30, ...settings }),
        cast: () => ({ charName: 'Mira', userName: 'Tom', card: 'A caravan guide in a medieval world.' }),
        gate: async index => { log.gate.push(index); return gate(index, state.chat[index]); },
        claude: async request => { log.claude.push(request); return JSON.stringify(await claude(request, state)); },
        inject: (sheet, memory) => log.inject.push({ sheet, memory }),
        persist: async (index, options) => { log.persist.push({ index, ...options }); },
        memory: () => state.memory,
        saveMemory: async () => { },
        status: (text, kind) => log.status.push({ text, kind }),
    };
    return { engine: new Engine(deps), state, log };
}

/** A chat where the notes say she is tied, the model has just replied, and nothing has looked at the reply. */
function freshReply(state, reply) {
    state.chat.push(bot('Hey!'), user('x'), bot(reply));
    state.chat[1].extra.goldfish = { sheet: TIED };
}

test('first message of a chat builds the notes from scratch and injects them', async () => {
    const { engine, state, log } = rig({ claude: async () => ({ sheet: TIED }) });
    state.chat.push(bot('Hey!'), user('*He ties her wrists behind her back and sits her on a log.*'));
    await engine.beforeGenerate('normal');
    assert.equal(log.gate.length, 0, 'no local check when there are no notes yet');
    assert.equal(log.claude.length, 1);
    assert.match(log.claude[0].user, /There is no sheet yet/);
    assert.match(log.inject[0].sheet, /wrists tied behind her back with rope/);
    assert.deepEqual(state.chat[1].extra.goldfish.sheet.people.Mira.restraints, ['wrists tied behind her back with rope']);
});

test('a fresh reply is not touched: swiping it asks nothing and changes nothing', async () => {
    const { engine, state, log } = rig({ claude: async () => { throw new Error('should not be called'); } });
    const reply = '*She wipes her mouth with the back of her wrist.*';
    freshReply(state, reply);
    await engine.beforeGenerate('swipe');
    assert.equal(log.claude.length, 0);
    assert.equal(log.gate.length, 0);
    assert.equal(state.chat[2].mes, reply);
    assert.equal(state.chat[2].extra.goldfish?.checked, undefined);
    assert.match(log.inject[0].sheet, /wrists tied behind her back/, 'the swipe is written from the state before the reply');
    await engine.memLock;
    assert.equal(log.claude.length, 0, 'no memory is written on a swipe either');
});

test('talk-only reply and talk-only message cost no Claude call and keep the notes', async () => {
    const { engine, state, log } = rig({ gate: () => false, claude: async () => { throw new Error('should not be called'); } });
    freshReply(state, '"Why are you doing this?"');
    state.chat.push(user('Because I can.'));
    await engine.beforeGenerate('normal');
    assert.deepEqual(log.gate, [2, 3]);
    assert.equal(log.claude.length, 0);
    assert.match(log.inject[0].sheet, /wrists tied/);
    assert.equal(state.chat[2].extra.goldfish.checked, true);
    assert.equal(state.chat[3].extra.goldfish.gate, 'no');
});

test('a physical message from the player updates the notes before the reply is written', async () => {
    const { engine, state, log } = rig({ gate: index => index === 3, claude: async () => ({ sheet: FREE }) });
    freshReply(state, '"Please."');
    state.chat.push(user('*He cuts the rope from her wrists.*'));
    await engine.beforeGenerate('normal');
    assert.deepEqual(log.claude.map(c => c.label), ['scene notes'], 'a talk-only reply is not sent for checking');
    assert.match(log.claude[0].user, /CURRENT SHEET/);
    assert.match(log.inject[0].sheet, /Restraints: none, free to move/);
    assert.match(log.inject[0].sheet, /Just changed: the rope was cut from her wrists/);
    assert.equal(state.chat[2].extra.goldfish.checked, true);
    assert.equal(state.chat[2].extra.goldfish.edited, undefined);
});

test('once the player sends the next message, the reply before it is fixed in one Claude call with the notes', async () => {
    const reply = '*She wipes her mouth with the back of her wrist, glaring.* "Does that feel lucky?"';
    const { engine, state, log } = rig({
        claude: async request => {
            assert.equal(request.label, 'reply check');
            return { edits: [{ find: 'wipes her mouth with the back of her wrist', replace: 'wipes her mouth against her shoulder', why: 'Her wrists are tied behind her back.' }], sheet: TIED };
        },
    });
    freshReply(state, reply);
    state.chat.push(user('"Answer the question."'));
    const { fixes } = await engine.beforeGenerate('normal');
    const m = state.chat[2];
    assert.equal(log.claude.length, 1);
    assert.deepEqual(log.gate, [2], 'a physical reply settles it: the message after it is not asked about separately');
    assert.match(log.claude[0].user, /THE REPLY TO CHECK:\n\[#2 Mira[\s\S]*MESSAGES AFTER THE REPLY[\s\S]*\[#3 Tom \(player\)\]/);
    assert.equal(m.mes, '*She wipes her mouth against her shoulder, glaring.* "Does that feel lucky?"');
    assert.equal(m.extra.goldfish.edited.original, reply);
    assert.equal(m.extra.goldfish.edited.edits[0].why, 'Her wrists are tied behind her back.');
    assert.equal(m.extra.goldfish.checked, true);
    assert.ok(state.chat[3].extra.goldfish.sheet, 'the notes now stand after the player\'s message');
    assert.deepEqual(log.persist.at(-1), { index: 2, rerender: true, save: true });
    assert.deepEqual(fixes.map(f => [f.index, f.original, f.text]), [[2, reply, m.mes]], 'the fix is reported so the prompt being built can use it');
    assert.match(log.inject[0].sheet, /wrists tied behind her back/);

    assert.equal(await engine.restore(2), true);
    assert.equal(m.mes, reply);
    assert.equal(state.chat[3].extra.goldfish.sheet, undefined, 'restoring drops the notes worked out from the fixed text');
});

test('a reply put back by the player is not fixed a second time', async () => {
    const reply = '*She wipes her mouth with the back of her wrist.*';
    let calls = 0;
    const { engine, state, log } = rig({
        claude: async request => {
            calls++;
            if (request.label === 'reply check') return { edits: [{ find: 'with the back of her wrist', replace: 'against her shoulder', why: 'Tied.' }], sheet: TIED };
            return { sheet: TIED };
        },
    });
    freshReply(state, reply);
    state.chat.push(user('"Well?"'));
    await engine.beforeGenerate('normal');
    await engine.restore(2);
    await engine.beforeGenerate('regenerate');
    assert.equal(calls, 2);
    assert.deepEqual(log.claude.map(c => c.label), ['reply check', 'scene notes']);
    assert.equal(state.chat[2].mes, reply);
});

test('a consistent reply is left alone', async () => {
    const { engine, state, log } = rig({ claude: async () => ({ edits: [], sheet: TIED }) });
    freshReply(state, '*She shifts on the log.* "Please."');
    state.chat.push(user('"No."'));
    const { fixes } = await engine.beforeGenerate('normal');
    assert.equal(state.chat[2].extra.goldfish.edited, undefined);
    assert.equal(state.chat[2].extra.goldfish.checked, true);
    assert.deepEqual(fixes, []);
    assert.deepEqual(log.persist.at(-1), { index: 2, rerender: false, save: true });
});

test('sending with an empty box accepts the reply too: it is checked on its own', async () => {
    const { engine, state, log } = rig({ claude: async () => ({ edits: [], sheet: TIED }) });
    freshReply(state, '*She shifts on the log.*');
    await engine.beforeGenerate('normal');
    assert.deepEqual(log.claude.map(c => c.label), ['reply check']);
    assert.doesNotMatch(log.claude[0].user, /MESSAGES AFTER THE REPLY/);
    assert.ok(state.chat[2].extra.goldfish.sheet);
});

test('a reply the player edited by hand is never fixed', async () => {
    const { engine, state, log } = rig({ claude: async () => ({ sheet: TIED }) });
    freshReply(state, '*She picks up a pencil.*');
    await engine.onEdited(2);
    state.chat.push(user('"Put it down."'));
    await engine.beforeGenerate('normal');
    assert.deepEqual(log.claude.map(c => c.label), ['scene notes']);
    assert.equal(state.chat[2].mes, '*She picks up a pencil.*');
});

test('with reply fixing off, replies are only counted in the notes', async () => {
    const { engine, state, log } = rig({ settings: { fixReplies: false }, claude: async () => ({ sheet: FREE }) });
    freshReply(state, '*She slips the rope.*');
    state.chat.push(user('"Hey!"'));
    await engine.beforeGenerate('normal');
    assert.deepEqual(log.claude.map(c => c.label), ['scene notes']);
    assert.match(log.claude[0].user, /\[#2 Mira \(character\)\][\s\S]*\[#3 Tom \(player\)\]/);
});

test('when Claude fails nothing is changed, and the next turn picks the reply up again', async () => {
    let fail = true;
    const { engine, state, log } = rig({
        settings: { interval: 99 },
        claude: async () => {
            if (fail) return 'I cannot help with that.';
            return { edits: [], sheet: FREE };
        },
    });
    const reply = '*She tugs at the rope.*';
    freshReply(state, reply);
    state.chat.push(user('"Stop that."'));
    await engine.beforeGenerate('normal');
    assert.equal(state.chat[2].mes, reply);
    assert.equal(state.chat[2].extra.goldfish?.checked, undefined);
    assert.equal(state.chat[3].extra.goldfish?.sheet, undefined);
    assert.equal(log.inject[0].sheet, '', 'old notes are not passed off as current');
    assert.equal(log.status.at(-1).kind, 'error');
    assert.match(log.status.at(-1).text, /nothing was changed/);

    fail = false;
    state.chat.push(bot('"Make me."'), user('*He cuts her loose.*'));
    await engine.beforeGenerate('normal');
    assert.equal(log.claude.at(-1).label, 'reply check');
    assert.match(log.claude.at(-1).user, /THE REPLY TO CHECK:\n\[#2 Mira \(character\)\]/, 'the reply that was missed is the one checked');
    assert.match(log.inject.at(-1).sheet, /free to move/);
    assert.equal(state.chat[4].extra.goldfish.checked, true);
});

test('when the notes cannot be updated, none are injected rather than stale ones', async () => {
    const { engine, state, log } = rig({ claude: async () => 'no json here' });
    state.chat.push(bot('Hey!'), user('x'), bot('...'), user('*He cuts the rope.*'));
    state.chat[2].extra.goldfish = { sheet: TIED, checked: true };
    await engine.beforeGenerate('normal');
    assert.equal(log.inject[0].sheet, '');
    assert.equal(log.status.at(-1).kind, 'error');
});

test('"after" timing: the reply is not held up by Claude, the notes say they are slightly old, and the check lands meanwhile', async () => {
    let physical = true;
    const { engine, state, log } = rig({
        settings: { timing: 'after', interval: 99 },
        gate: () => physical,
        claude: async () => ({ edits: [{ find: 'tugs at', replace: 'strains against', why: 'test' }], sheet: FREE }),
    });
    freshReply(state, '*She tugs at the rope.*');
    state.chat.push(user('*He cuts the rope from her wrists.*'));
    const { fixes } = await engine.beforeGenerate('normal');
    assert.deepEqual(log.gate, [2], 'the quick local check still runs first');
    assert.match(log.inject[0].sheet, /as of a moment ago/);
    assert.match(log.inject[0].sheet, /wrists tied behind her back/);
    assert.equal(fixes.length, 0, 'nothing was fixed in time for this prompt');
    assert.equal(state.chat[2].mes, '*She tugs at the rope.*');

    await engine.lock;
    assert.deepEqual(log.claude.map(c => c.label), ['reply check']);
    assert.equal(state.chat[2].mes, '*She strains against the rope.*');
    assert.deepEqual(state.chat[3].extra.goldfish.sheet.people.Mira.restraints, []);

    physical = false;
    state.chat.push(bot('"Finally."'), user('Good.'));
    await engine.beforeGenerate('normal');
    assert.match(log.inject.at(-1).sheet, /These are true right now/, 'up-to-date notes are presented as current');
    assert.equal(log.claude.length, 1);
});

test('turned off, it injects nothing and calls nothing', async () => {
    const { engine, state, log } = rig({ settings: { enabled: false }, claude: async () => { throw new Error('no'); } });
    state.chat.push(bot('Hey!'), user('x'));
    const { fixes } = await engine.beforeGenerate('normal');
    assert.deepEqual(fixes, []);
    assert.deepEqual(log.inject, [{ sheet: '', memory: '' }]);
    assert.equal(log.claude.length, 0);
});

test('memory: chapters are written once enough messages are old, and feed the prompt', async () => {
    const { engine, state, log } = rig({
        gate: () => false,
        claude: async request => {
            assert.equal(request.label, 'memory');
            return { summary: 'Tom tied Mira up at the forest camp and said they were going to Artifica.', keywords: ['camp', 'artifica'], facts: ['Tom is taking Mira to Artifica.'] };
        },
    });
    for (let i = 0; i < 3; i++) state.chat.push(user(`line ${i}`), bot(`reply ${i}`));
    state.chat[4].extra.goldfish = { sheet: TIED };
    assert.equal(await engine.summarizeDue(), 1); // 6 messages, keep 2 recent, interval 4 -> messages 0..3
    assert.deepEqual(state.memory.chapters.map(c => [c.from, c.to]), [[0, 3]]);
    assert.deepEqual(state.memory.facts, ['Tom is taking Mira to Artifica.']);
    assert.equal(await engine.summarizeDue(), 0);

    state.chat.push(user('Where are we going?'));
    await engine.beforeGenerate('normal');
    assert.match(log.inject.at(-1).memory, /Tom is taking Mira to Artifica\./);
    assert.match(log.inject.at(-1).memory, /Tom tied Mira up at the forest camp/);
});

test('memory is written when the player sends a message, not when a reply arrives', async () => {
    const { engine, state, log } = rig({
        gate: () => false,
        claude: async () => ({ summary: 'They talked at the camp.', keywords: ['camp'], facts: [] }),
    });
    for (let i = 0; i < 3; i++) state.chat.push(user(`line ${i}`), bot(`reply ${i}`));
    state.chat[4].extra.goldfish = { sheet: TIED };
    state.chat.push(user('And then?'));
    await engine.beforeGenerate('normal');
    await engine.memLock;
    assert.deepEqual(log.claude.map(c => c.label), ['memory']);
    assert.deepEqual(state.memory.chapters.map(c => [c.from, c.to]), [[0, 4]]); // 7 messages, the newest 2 kept back
});

test('editing an old message throws away what was derived from it onward', async () => {
    const { engine, state } = rig({ claude: async () => ({ sheet: TIED }) });
    for (let i = 0; i < 4; i++) state.chat.push(user(`u${i}`), bot(`b${i}`));
    for (const m of state.chat) m.extra.goldfish = { sheet: TIED };
    state.memory = normalizeMemory({ chapters: [{ from: 0, to: 3, summary: 'a' }, { from: 4, to: 5, summary: 'b' }] });
    await engine.onEdited(2);
    assert.ok(state.chat[1].extra.goldfish.sheet);
    assert.equal(state.chat[2].extra.goldfish.sheet, undefined);
    assert.equal(state.chat[7].extra.goldfish.sheet, undefined);
    assert.equal(state.memory.chapters.length, 0);
    assert.equal(state.memory.through, -1);
});

test('a correction from the player overrides the notes and leaves a fresh reply alone', async () => {
    const { engine, state, log } = rig({ claude: async () => ({ sheet: FREE }) });
    freshReply(state, '*She glares.*');
    const sheet = await engine.correct('She is not tied up any more.');
    assert.match(log.claude[0].user, /CORRECTION FROM THE PLAYER[\s\S]*She is not tied up any more\./);
    assert.deepEqual(sheet.people.Mira.restraints, []);
    assert.deepEqual(state.chat[1].extra.goldfish.sheet.people.Mira.restraints, [], 'the corrected notes sit on the last accepted message');
    assert.equal(state.chat[2].extra.goldfish?.sheet, undefined);
    assert.equal(engine.unchecked(state.chat[2]), true, 'the fresh reply is still checked when the player moves on');
});
