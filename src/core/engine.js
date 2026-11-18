// The turn logic, with no SillyTavern in it: everything it touches comes in through `deps`,
// so the same code runs in the browser and in the tests.
//
// A sheet stored on a message is the state of the scene AFTER that message.
//
// Nothing happens when a reply arrives. The player may read it, swipe it, edit it or delete it.
// A reply counts as accepted the moment the player moves on (sends the next message), and only
// then is it checked, fixed if needed, and counted in the notes and the memory.
//
// deps = {
//   chat():            the live message array
//   chatId():          changes when the user opens another chat
//   settings():        { enabled, gateMode: 'local'|'always', timing: 'before'|'after', fixReplies, interval, keepRecent, memoryBudget, rebuildWindow }
//   cast():            { charName, userName, card }
//   gate(index):       Promise<boolean>  the local model's one-word check on one message
//   claude({system, user, label}): Promise<string>
//   inject(sheetText, memoryText): put the notes into the next prompt
//   persist(index, {rerender, save}): Promise  after a message's text or data changed
//   memory():          the chat's memory object (mutable)
//   saveMemory():      Promise
//   status(text, kind) kind = 'busy' | 'ok' | 'warn' | 'error'
// }

import { extractJson } from './json.js';
import { normalizeSheet, renderSheet } from './sheet.js';
import { applyEdits } from './edits.js';
import { dueRange, dropFrom, renderMemory } from './memory.js';
import { buildAdvance, buildCheck, buildSummarize } from './prompts.js';

const CHECK_CONTEXT = 6;
const ADVANCE_CONTEXT = 4;
const MAX_CHAPTERS_PER_PASS = 5;
// More new messages than this at once (a chat opened half way, a failed turn) go straight to Claude.
const MAX_GATED = 3;

const DECLINED = 'It may have declined this message.';

function reason(error) {
    return String(error?.message || error || 'unknown error').replace(/\s+/g, ' ').slice(0, 300);
}

export class Engine {
    constructor(deps) {
        this.deps = deps;
        this.lock = Promise.resolve();
        this.memLock = Promise.resolve();
        this.fixes = [];
    }

    // ---------- per-message data ----------

    data(message) {
        return message?.extra?.goldfish ?? null;
    }

    setData(message, patch) {
        message.extra ??= {};
        message.extra.goldfish = { ...(message.extra.goldfish ?? {}), ...patch };
    }

    clearData(message, ...keys) {
        const d = this.data(message);
        if (!d) return;
        for (const key of keys) delete d[key];
    }

    /** A reply from the model that has not been looked over yet. */
    unchecked(message) {
        return Boolean(message) && !message.is_user && !message.is_system && !this.data(message)?.checked;
    }

    /** The last message that counts as accepted: a newest reply nobody has moved on from is left out. */
    acceptedEnd() {
        const chat = this.deps.chat();
        const last = chat.length - 1;
        return last > 0 && this.unchecked(chat[last]) ? last - 1 : last;
    }

    /** The newest sheet at or before `index`, or null. */
    sheetAt(index) {
        const chat = this.deps.chat();
        for (let i = Math.min(index, chat.length - 1); i >= 0; i--) {
            const sheet = this.data(chat[i])?.sheet;
            if (sheet) return sheet;
        }
        return null;
    }

    /** Messages from..to as transcript entries (system messages and empty ones left out). */
    list(from, to) {
        const chat = this.deps.chat();
        const out = [];
        for (let i = Math.max(0, from); i <= Math.min(to, chat.length - 1); i++) {
            const m = chat[i];
            if (!m || m.is_system) continue;
            const text = String(m.mes ?? '').trim();
            if (text) out.push({ index: i, name: m.name || (m.is_user ? 'Player' : 'Character'), isUser: Boolean(m.is_user), text });
        }
        return out;
    }

    /** One job at a time, in order. */
    exclusive(fn) {
        const run = this.lock.then(() => fn());
        this.lock = run.catch(() => { });
        return run;
    }

    // ---------- the sheet ----------

    /** Ask Claude for the sheet after messages from..to, starting from `prev` (or from nothing). */
    async advance(prev, from, to, correction = '') {
        const messages = this.list(from, to);
        if (!messages.length && !correction) return prev;
        const context = prev ? this.list(from - ADVANCE_CONTEXT, from - 1) : [];
        const prompt = buildAdvance({ cast: this.deps.cast(), sheet: prev, context, messages, correction });
        const out = extractJson(await this.deps.claude({ ...prompt, label: 'scene notes' }));
        const sheet = normalizeSheet(out?.sheet ?? out);
        if (!sheet) throw new Error(`Claude did not return usable scene notes. ${DECLINED}`);
        return sheet;
    }

    /**
     * Work out what it takes to bring everything up to message `through` into the record.
     * The cheap part happens here: the local model's one-word checks. Returns { sheet } when that
     * settled it, or { job } when Claude is needed; job() does the work and returns the sheet.
     */
    async triage(through) {
        const chat = this.deps.chat();
        if (through < 0 || through >= chat.length) return { sheet: null };
        const s = this.deps.settings();
        let known = through;
        while (known >= 0 && !this.data(chat[known])?.sheet) known--;
        if (known === through) return { sheet: this.data(chat[through]).sheet };
        const prev = known >= 0 ? this.data(chat[known]).sheet : null;
        const pending = this.list(known + 1, through);
        if (!pending.length) return { sheet: prev };

        const replies = pending.filter(m => !m.isUser && this.unchecked(chat[m.index]));
        const accept = () => { for (const m of replies) this.setData(chat[m.index], { checked: true }); };

        if (!prev) {
            // No notes yet, so nothing to check a reply against: start the record.
            return {
                job: async () => {
                    const guard = this.guard(through);
                    this.deps.status('Writing the scene notes…', 'busy');
                    const sheet = await this.advance(null, Math.max(0, through - s.rebuildWindow + 1), through);
                    if (guard.gone()) return null;
                    this.setData(chat[through], { sheet, gate: 'yes' });
                    accept();
                    this.deps.status('Scene notes written', 'ok');
                    return sheet;
                },
            };
        }

        const reply = s.fixReplies ? replies[0] ?? null : null;
        let check = Boolean(reply);
        if (s.gateMode === 'local' && pending.length <= MAX_GATED) {
            const ask = async m => {
                try {
                    return await this.deps.gate(m.index);
                } catch (error) {
                    console.warn('[Goldfish Therapy] local check failed, asking Claude instead:', reason(error));
                    return true;
                }
            };
            if (reply) check = await ask(reply);
            let physical = check;
            if (!physical) {
                for (const m of pending) {
                    if (m === reply) continue;
                    if (await ask(m)) { physical = true; break; }
                }
            }
            if (!physical) {
                this.setData(chat[through], { sheet: prev, gate: 'no' });
                accept();
                return { sheet: prev };
            }
        }

        return {
            job: () => (check
                ? this.checkAndAdvance(prev, known, reply, through, accept)
                : this.advanceThrough(prev, known, through, accept)),
        };
    }

    /** Tells a job that the chat moved on under it while Claude was answering. */
    guard(through, replyIndex = -1) {
        const chat = this.deps.chat();
        const chatId = this.deps.chatId();
        const target = chat[through];
        const reply = replyIndex >= 0 ? chat[replyIndex] : null;
        const text = reply?.mes;
        const swipe = reply?.swipe_id;
        return {
            gone: () => this.deps.chatId() !== chatId || this.deps.chat()[through] !== target
                || (reply !== null && (this.deps.chat()[replyIndex] !== reply || reply.mes !== text || reply.swipe_id !== swipe)),
        };
    }

    async advanceThrough(prev, known, through, accept) {
        const chat = this.deps.chat();
        const guard = this.guard(through);
        this.deps.status('Updating the scene notes…', 'busy');
        const sheet = await this.advance(prev, known + 1, through);
        if (guard.gone()) return null;
        this.setData(chat[through], { sheet, gate: 'yes' });
        accept();
        this.deps.status('Scene notes updated', 'ok');
        return sheet;
    }

    /**
     * One Claude call: check the accepted reply, fix it if needed, and bring the notes up to date
     * with it and with whatever followed it (normally the player's new message).
     */
    async checkAndAdvance(prev, known, reply, through, accept) {
        const chat = this.deps.chat();
        const message = chat[reply.index];
        const text = message.mes;
        const guard = this.guard(through, reply.index);
        let sheet = prev;
        if (this.list(known + 1, reply.index - 1).length) {
            // Rare: something before the reply was never counted (a failed turn). Count it first.
            this.deps.status('Updating the scene notes…', 'busy');
            sheet = await this.advance(prev, known + 1, reply.index - 1);
            if (guard.gone()) return null;
            this.setData(chat[reply.index - 1], { sheet, gate: 'yes' });
        }

        this.deps.status('Checking the last reply…', 'busy');
        const prompt = buildCheck({
            cast: this.deps.cast(),
            sheet,
            context: this.list(reply.index - CHECK_CONTEXT, reply.index - 1),
            reply: this.list(reply.index, reply.index)[0],
            after: this.list(reply.index + 1, through),
        });
        const out = extractJson(await this.deps.claude({ ...prompt, label: 'reply check' }));
        const next = normalizeSheet(out?.sheet);
        if (!out || !next) throw new Error(`Claude did not return a usable answer. ${DECLINED}`);
        if (guard.gone()) return null;

        const result = applyEdits(text, out.edits);
        const patch = { checked: true };
        if (result.applied.length) {
            patch.edited = { original: text, edits: result.applied };
            message.mes = result.text;
            this.fixes.push({ index: reply.index, original: text, text: result.text, edits: result.applied });
        }
        this.setData(message, patch);
        accept();
        this.setData(chat[through], { sheet: next, gate: 'yes' });
        await this.deps.persist(reply.index, { rerender: result.applied.length > 0, save: true });
        if (result.skipped.length) console.warn('[Goldfish Therapy] edits not applied:', result.skipped);
        const n = result.applied.length;
        this.deps.status(n ? `Fixed ${n} continuity slip${n === 1 ? '' : 's'} in the last reply` : 'The last reply is consistent', 'ok');
        return next;
    }

    // ---------- the hook ----------

    /**
     * Runs just before SillyTavern builds the prompt for a reply. This is the only moment the
     * add-on works on the chat: the player has moved on, so everything already there is accepted.
     * Returns { fixes }: the replies whose text was changed in time for this prompt.
     */
    async beforeGenerate(type) {
        const s = this.deps.settings();
        this.fixes = [];
        if (!s.enabled) {
            this.deps.inject('', '');
            return { fixes: [] };
        }
        if (type === 'quiet' || type === 'impersonate') return { fixes: [] };
        const chat = this.deps.chat();
        const last = chat.length - 1;
        // A swipe or a continue rewrites the last message: it is not accepted, and the state that
        // counts is the one before it. Nothing worked out for its old text may carry over.
        const redo = type === 'swipe' || type === 'continue';
        const through = redo ? last - 1 : last;
        if (redo && chat[last]) this.clearData(chat[last], 'sheet', 'edited', 'gate', 'checked');

        let sheet = null;
        let stale = false;
        const failed = error => this.deps.status(`Could not check the last reply or update the scene notes, so nothing was changed. ${reason(error)}`, 'error');
        try {
            if (s.timing === 'after') {
                // Do not wait for Claude: the reply starts from the notes as they were, marked as
                // slightly old, and the check lands while the reply is being written.
                const plan = await this.exclusive(() => this.triage(through));
                if (plan.job) {
                    sheet = this.sheetAt(through);
                    stale = Boolean(sheet);
                    this.exclusive(plan.job).catch(failed);
                } else {
                    sheet = plan.sheet;
                }
            } else {
                sheet = await this.exclusive(async () => {
                    const plan = await this.triage(through);
                    return plan.job ? plan.job() : plan.sheet;
                });
            }
        } catch (error) {
            // Old notes presented as current would contradict the newest message, so none are sent.
            sheet = null;
            stale = false;
            failed(error);
        }
        this.deps.inject(renderSheet(sheet, { stale }), this.memoryText(through));
        if (!redo) this.summarizeSoon();
        return { fixes: this.fixes };
    }

    // ---------- memory ----------

    memoryText(index) {
        const s = this.deps.settings();
        const recent = this.list(index - 3, index).map(m => m.text).join('\n');
        return renderMemory(this.deps.memory(), recent, s.memoryBudget);
    }

    /** Summarize in the background; never holds up the chat. */
    summarizeSoon() {
        this.memLock = this.memLock
            .then(() => this.summarizeDue())
            .catch(error => this.deps.status(`Could not write the memory this time. ${reason(error)}`, 'warn'));
        return this.memLock;
    }

    /** Summarize everything that is old enough, even if a full interval has not built up. */
    summarizeNow() {
        this.memLock = this.memLock.then(() => this.summarizeDue(true));
        return this.memLock;
    }

    async summarizeDue(force = false) {
        const s = this.deps.settings();
        if (!s.enabled) return 0;
        const chatId = this.deps.chatId();
        let made = 0;
        for (let pass = 0; pass < MAX_CHAPTERS_PER_PASS; pass++) {
            const memory = this.deps.memory();
            const range = dueRange({
                chatLength: this.deps.chat().length,
                through: memory.through,
                interval: force ? 1 : s.interval,
                keepRecent: s.keepRecent,
            });
            if (!range) break;
            const messages = this.list(range.from, range.to);
            if (messages.length) {
                this.deps.status('Writing a memory of earlier messages…', 'busy');
                const prompt = buildSummarize({
                    cast: this.deps.cast(),
                    facts: memory.facts,
                    earlier: memory.chapters.slice(-4).map(c => c.summary),
                    messages,
                });
                const out = extractJson(await this.deps.claude({ ...prompt, label: 'memory' }));
                const summary = String(out?.summary ?? '').replace(/\s+/g, ' ').trim();
                if (!summary) throw new Error(`Claude did not return a usable summary. ${DECLINED}`);
                if (this.deps.chatId() !== chatId) return made;
                memory.chapters.push({
                    from: range.from,
                    to: range.to,
                    summary,
                    keywords: (Array.isArray(out.keywords) ? out.keywords : []).map(k => String(k).toLowerCase().trim()).filter(Boolean).slice(0, 14),
                });
                if (Array.isArray(out.facts)) {
                    memory.facts = out.facts.map(f => String(f).replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 24);
                }
                made++;
            }
            memory.through = range.to;
            await this.deps.saveMemory();
        }
        if (made) this.deps.status(`Memory updated (${made} new chapter${made === 1 ? '' : 's'})`, 'ok');
        return made;
    }

    // ---------- things the user does ----------

    /** A message's text was edited by hand: what was worked out from it onward no longer holds. */
    async onEdited(index) {
        const chat = this.deps.chat();
        const message = chat[index];
        if (message) {
            this.clearData(message, 'edited');
            // Text the player wrote over a reply is the player's: it is never "fixed".
            if (!message.is_user && !message.is_system) this.setData(message, { checked: true });
        }
        for (let i = index; i < chat.length; i++) this.clearData(chat[i], 'sheet', 'gate');
        await this.forgetMemoryFrom(index);
    }

    /** Messages were deleted; `length` is the new chat length. */
    async onDeleted(length) {
        await this.forgetMemoryFrom(length);
    }

    async forgetMemoryFrom(index) {
        const memory = this.deps.memory();
        if (memory.through < index) return;
        dropFrom(memory, index);
        await this.deps.saveMemory();
    }

    /** Put a fixed reply back the way the local model wrote it. It is not fixed a second time. */
    async restore(index) {
        const chat = this.deps.chat();
        const message = chat[index];
        const edited = this.data(message)?.edited;
        if (!edited) return false;
        message.mes = edited.original;
        this.clearData(message, 'edited');
        this.setData(message, { checked: true });
        for (let i = index; i < chat.length; i++) this.clearData(chat[i], 'sheet', 'gate');
        await this.deps.persist(index, { rerender: true, save: true });
        return true;
    }

    /** The player says the notes are wrong: Claude rewrites them with that correction on top. */
    correct(note) {
        return this.exclusive(async () => {
            const chat = this.deps.chat();
            const end = this.acceptedEnd();
            if (end < 0) return null;
            const s = this.deps.settings();
            const prev = this.sheetAt(end);
            this.deps.status('Correcting the scene notes…', 'busy');
            const sheet = prev
                ? await this.advance(prev, end + 1, end, note)
                : await this.advance(null, Math.max(0, end - s.rebuildWindow + 1), end, note);
            this.setData(chat[end], { sheet, gate: 'yes' });
            await this.deps.persist(end, { rerender: false, save: true });
            this.deps.status('Scene notes corrected', 'ok');
            return sheet;
        });
    }

    /** Throw the notes away and work them out again from the recent messages. */
    rebuild() {
        return this.exclusive(async () => {
            const chat = this.deps.chat();
            const end = this.acceptedEnd();
            if (end < 0) return null;
            const s = this.deps.settings();
            for (const m of chat) this.clearData(m, 'sheet', 'gate');
            this.deps.status('Rebuilding the scene notes…', 'busy');
            const sheet = await this.advance(null, Math.max(0, end - s.rebuildWindow + 1), end);
            this.setData(chat[end], { sheet, gate: 'yes' });
            await this.deps.persist(end, { rerender: false, save: true });
            this.deps.status('Scene notes rebuilt', 'ok');
            return sheet;
        });
    }
}
