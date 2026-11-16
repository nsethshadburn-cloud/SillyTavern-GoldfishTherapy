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
        settings: () => ({ enabled: true, gateMode: 'local', fixReplies: true, interval: 4, keepRecent: 2, memoryBudget: 2000, rebuildWindow: 30, ...settings }),
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

test('a talk-only message costs no Claude call and keeps the notes', async () => {
    const { engine, state, log } = rig({ gate: () => false, claude: async () => { throw new Error('should not be called'); } });
    state.chat.push(bot('Hey!'), user('x'));
    state.chat[1].extra.goldfish = { sheet: TIED };
    state.chat.push(bot('"Why are you doing this?"'), user('Because I can.'));
    state.chat[2].extra.goldfish = { sheet: TIED };
    await engine.beforeGenerate('normal');
    assert.deepEqual(log.gate, [3]);
    assert.equal(log.claude.length, 0);
    assert.match(log.inject[0].sheet, /wrists tied/);
    assert.equal(state.chat[3].extra.goldfish.gate, 'no');
});

test('a physical message from the player updates the notes before the reply is written', async () => {
    const { engine, state, log } = rig({ claude: async () => ({ sheet: FREE }) });
    state.chat.push(bot('Hey!'), user('x'), bot('...'), user('*He cuts the rope from her wrists.*'));
    state.chat[2].extra.goldfish = { sheet: TIED };
    await engine.beforeGenerate('normal');
    assert.equal(log.claude.length, 1);
    assert.match(log.claude[0].user, /CURRENT SHEET/);
    assert.match(log.inject[0].sheet, /Restraints: none, free to move/);
    assert.match(log.inject[0].sheet, /Just changed: the rope was cut from her wrists/);
});

test('a reply that breaks the notes is fixed, the original is kept, and the notes move on', async () => {
    const reply = '*She wipes her mouth with the back of her wrist, glaring.* "Does that feel lucky?"';
    const { engine, state, log } = rig({
        claude: async request => {
            assert.equal(request.label, 'reply check');
            return { edits: [{ find: 'wipes her mouth with the back of her wrist', replace: 'wipes her mouth against her shoulder', why: 'Her wrists are tied behind her back.' }], sheet: TIED };
        },
    });
    state.chat.push(bot('Hey!'), user('x'), bot(reply));
    state.chat[1].extra.goldfish = { sheet: TIED };
    await engine.afterReply(2, 'normal');
    const m = state.chat[2];
    assert.equal(m.mes, '*She wipes her mouth against her shoulder, glaring.* "Does that feel lucky?"');
    assert.equal(m.extra.goldfish.edited.original, reply);
    assert.equal(m.extra.goldfish.edited.edits[0].why, 'Her wrists are tied behind her back.');
    assert.deepEqual(log.persist.at(-1), { index: 2, rerender: true, save: true });
    assert.match(log.status.at(-1).text, /Fixed 1 continuity slip/);

    assert.equal(await engine.restore(2), true);
    assert.equal(m.mes, reply);
    assert.equal(m.extra.goldfish.sheet, undefined, 'restoring drops the notes worked out from the fixed text');
});

test('a consistent reply is left alone', async () => {
    const { engine, state, log } = rig({ claude: async () => ({ edits: [], sheet: TIED }) });
    state.chat.push(bot('Hey!'), user('x'), bot('*She shifts on the log.* "Please."'));
    state.chat[1].extra.goldfish = { sheet: TIED };
    await engine.afterReply(2, 'normal');
    assert.equal(state.chat[2].extra.goldfish.edited, undefined);
    assert.deepEqual(log.persist.at(-1), { index: 2, rerender: false, save: true });
});

test('a swipe is written from the state before the swiped reply, not after it', async () => {
    const { engine, state, log } = rig({ claude: async () => { throw new Error('should not be called'); } });
    state.chat.push(bot('Hey!'), user('x'), bot('*She slips the rope and runs.*'));
    state.chat[1].extra.goldfish = { sheet: TIED };
    state.chat[2].extra.goldfish = { sheet: FREE };
    await engine.beforeGenerate('swipe');
    assert.match(log.inject[0].sheet, /wrists tied behind her back/);
});

test('when Claude fails the reply is untouched and the next turn folds it in', async () => {
    let fail = true;
    const { engine, state, log } = rig({
        claude: async () => {
            if (fail) return 'I cannot help with that.';
            return { sheet: FREE };
        },
    });
    const reply = '*She tugs at the rope.*';
    state.chat.push(bot('Hey!'), user('x'), bot(reply));
    state.chat[1].extra.goldfish = { sheet: TIED };
    await engine.afterReply(2, 'normal');
    assert.equal(state.chat[2].mes, reply);
    assert.equal(state.chat[2].extra.goldfish?.sheet, undefined);
    assert.equal(log.status.at(-1).kind, 'error');
    assert.match(log.status.at(-1).text, /left as written/);

    fail = false;
    state.chat.push(user('*He cuts her loose.*'));
    await engine.beforeGenerate('normal');
    assert.match(log.claude.at(-1).user, /\[#2 Mira \(character\)\]/, 'the unchecked reply is sent along with the new message');
    assert.match(log.inject.at(-1).sheet, /free to move/);
});

test('when the notes cannot be updated, none are injected rather than stale ones', async () => {
    const { engine, state, log } = rig({ claude: async () => 'no json here' });
    state.chat.push(bot('Hey!'), user('x'), bot('...'), user('*He cuts the rope.*'));
    state.chat[2].extra.goldfish = { sheet: TIED };
    await engine.beforeGenerate('normal');
    assert.equal(log.inject[0].sheet, '');
    assert.equal(log.status.at(-1).kind, 'error');
});

test('"after" timing: the reply is not held up, the notes say they are one message behind, and catch up afterwards', async () => {
    const { engine, state, log } = rig({ settings: { timing: 'after' }, claude: async request => (request.label === 'reply check' ? { edits: [], sheet: FREE } : { sheet: FREE }) });
    state.chat.push(bot('Hey!'), user('x'), bot('...'), user('*He cuts the rope from her wrists.*'));
    state.chat[2].extra.goldfish = { sheet: TIED };
    await engine.beforeGenerate('normal');
    assert.equal(log.claude.length, 0, 'nothing is asked before the reply');
    assert.equal(log.gate.length, 0);
    assert.match(log.inject[0].sheet, /as of just before the newest message/);
    assert.match(log.inject[0].sheet, /wrists tied behind her back/);

    state.chat.push(bot('*She rubs her wrists.* "Finally."'));
    await engine.afterReply(4, 'normal');
    assert.deepEqual(log.claude.map(c => c.label), ['scene notes', 'reply check']);
    assert.deepEqual(state.chat[3].extra.goldfish.sheet.people.Mira.restraints, []);
    assert.ok(state.chat[4].extra.goldfish.sheet);

    state.chat.push(user('Good.'));
    state.chat[5].extra.goldfish = { sheet: FREE };
    await engine.beforeGenerate('normal');
    assert.match(log.inject.at(-1).sheet, /These are true right now/, 'up-to-date notes are presented as current');
});

test('turned off, it injects nothing and calls nothing', async () => {
    const { engine, state, log } = rig({ settings: { enabled: false }, claude: async () => { throw new Error('no'); } });
    state.chat.push(bot('Hey!'), user('x'));
    await engine.beforeGenerate('normal');
    await engine.afterReply(0, 'normal');
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
    state.chat[0].extra.goldfish = { sheet: TIED };
    assert.equal(await engine.summarizeDue(), 1); // 6 messages, keep 2 recent, interval 4 -> messages 0..3
    assert.deepEqual(state.memory.chapters.map(c => [c.from, c.to]), [[0, 3]]);
    assert.deepEqual(state.memory.facts, ['Tom is taking Mira to Artifica.']);
    assert.equal(await engine.summarizeDue(), 0);

    state.chat.push(user('Where are we going?'));
    await engine.beforeGenerate('normal');
    assert.match(log.inject.at(-1).memory, /Tom is taking Mira to Artifica\./);
    assert.match(log.inject.at(-1).memory, /Tom tied Mira up at the forest camp/);
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

test('a correction from the player overrides the notes', async () => {
    const { engine, state, log } = rig({ claude: async () => ({ sheet: FREE }) });
    state.chat.push(bot('Hey!'), user('x'));
    state.chat[1].extra.goldfish = { sheet: TIED };
    const sheet = await engine.correct('She is not tied up any more.');
    assert.match(log.claude[0].user, /CORRECTION FROM THE PLAYER[\s\S]*She is not tied up any more\./);
    assert.deepEqual(sheet.people.Mira.restraints, []);
    assert.deepEqual(engine.sheetAt(1).people.Mira.restraints, []);
});
