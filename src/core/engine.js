// The turn logic, with no SillyTavern in it: everything it touches comes in through `deps`,
// so the same code runs in the browser and in the tests.
//
// A sheet stored on a message is the state of the scene AFTER that message.
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

const DECLINED = 'It may have declined this message.';

function reason(error) {
    return String(error?.message || error || 'unknown error').replace(/\s+/g, ' ').slice(0, 300);
}

export class Engine {
    constructor(deps) {
        this.deps = deps;
        this.lock = Promise.resolve();
        this.memLock = Promise.resolve();
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
     * Make sure message `index` carries a sheet, and return it.
     * One new message goes through the local check first; anything else goes straight to Claude.
     */
    async ensureThrough(index) {
        const chat = this.deps.chat();
        if (index < 0 || index >= chat.length) return null;
        const s = this.deps.settings();
        let known = index;
        while (known >= 0 && !this.data(chat[known])?.sheet) known--;
        if (known === index) return this.data(chat[index]).sheet;
        const prev = known >= 0 ? this.data(chat[known]).sheet : null;
        const pending = this.list(known + 1, index);
        if (!pending.length) return prev;

        if (prev && pending.length === 1 && s.gateMode === 'local') {
            let changed = true;
            try {
                changed = await this.deps.gate(pending[0].index);
            } catch (error) {
                console.warn('[Goldfish Therapy] local check failed, asking Claude instead:', reason(error));
            }
            if (!changed) {
                this.setData(chat[index], { sheet: prev, gate: 'no' });
                return prev;
            }
        }

        this.deps.status('Updating the scene notes…', 'busy');
        const from = prev ? known + 1 : Math.max(0, index - s.rebuildWindow + 1);
        const sheet = await this.advance(prev, from, index);
        this.setData(chat[index], { sheet, gate: 'yes' });
        this.deps.status('Scene notes updated', 'ok');
        return sheet;
    }

    // ---------- the two hooks ----------

    /** Runs just before SillyTavern builds the prompt for a reply. */
    async beforeGenerate(type) {
        const s = this.deps.settings();
        if (!s.enabled) {
            this.deps.inject('', '');
            return;
        }
        if (type === 'quiet' || type === 'impersonate') return;
        const chat = this.deps.chat();
        const last = chat.length - 1;
        // A swipe or a continue rewrites the last message, so the state that counts is the one before it.
        const prevIndex = (type === 'swipe' || type === 'continue') ? last - 1 : last;
        // A new swipe is a new reply: nothing worked out for the old one may carry over to it.
        if (type === 'swipe' && chat[last]) this.clearData(chat[last], 'sheet', 'edited', 'gate');
        let sheet = null;
        let stale = false;
        if (s.timing === 'after') {
            // No waiting before the reply: the notes are one message behind and say so.
            // The newest message is folded in after the reply, when the reply is checked.
            await this.lock;
            sheet = this.sheetAt(prevIndex);
            stale = Boolean(sheet) && !this.data(chat[prevIndex])?.sheet;
        } else {
            try {
                sheet = await this.exclusive(() => this.ensureThrough(prevIndex));
            } catch (error) {
                // Old notes presented as current would contradict the newest message, so none are sent.
                this.deps.status(`Could not update the scene notes, so this reply is written without them. ${reason(error)}`, 'error');
            }
        }
        this.deps.inject(renderSheet(sheet, { stale }), this.memoryText(prevIndex));
    }

    /** Runs when a reply has arrived. Checks it, fixes it if needed, and records the new state. */
    async afterReply(index, type = 'normal') {
        const s = this.deps.settings();
        if (!s.enabled || type === 'first_message' || type === 'impersonate') return;
        const chat = this.deps.chat();
        const message = chat[index];
        if (!message || message.is_user || message.is_system || index !== chat.length - 1) return;
        if (!String(message.mes ?? '').trim()) return;
        try {
            await this.exclusive(() => this.checkReply(index, type));
        } catch (error) {
            this.deps.status(`Could not check the reply, so it was left as written. ${reason(error)}`, 'error');
        }
        this.summarizeSoon();
    }

    async checkReply(index, type) {
        const s = this.deps.settings();
        const chatId = this.deps.chatId();
        const message = this.deps.chat()[index];
        if (type === 'continue') this.clearData(message, 'sheet', 'edited', 'gate');
        if (this.data(message)?.sheet) return;
        const text = message.mes;
        const swipe = message.swipe_id;
        const stale = () => this.deps.chatId() !== chatId || this.deps.chat()[index] !== message || message.mes !== text || message.swipe_id !== swipe;

        const prev = await this.ensureThrough(index - 1);
        if (stale()) return;
        if (!prev) {
            // Nothing before this reply to compare it with: just start the record.
            const sheet = await this.advance(null, Math.max(0, index - s.rebuildWindow + 1), index);
            if (stale()) return;
            this.setData(message, { sheet, gate: 'yes' });
            await this.deps.persist(index, { rerender: false, save: true });
            return;
        }

        let changed = true;
        if (s.gateMode === 'local') {
            try {
                changed = await this.deps.gate(index);
            } catch (error) {
                console.warn('[Goldfish Therapy] local check failed, asking Claude instead:', reason(error));
            }
            if (stale()) return;
        }
        if (!changed) {
            this.setData(message, { sheet: prev, gate: 'no' });
            await this.deps.persist(index, { rerender: false, save: true });
            this.deps.status('Nothing physical in that reply', 'ok');
            return;
        }

        if (!s.fixReplies) {
            this.deps.status('Updating the scene notes…', 'busy');
            const sheet = await this.advance(prev, index, index);
            if (stale()) return;
            this.setData(message, { sheet, gate: 'yes' });
            await this.deps.persist(index, { rerender: false, save: true });
            this.deps.status('Scene notes updated', 'ok');
            return;
        }

        this.deps.status('Checking the reply…', 'busy');
        const prompt = buildCheck({
            cast: this.deps.cast(),
            sheet: prev,
            context: this.list(index - CHECK_CONTEXT, index - 1),
            reply: this.list(index, index)[0],
        });
        const out = extractJson(await this.deps.claude({ ...prompt, label: 'reply check' }));
        if (!out) throw new Error(`Claude did not return a usable answer. ${DECLINED}`);
        if (stale()) return;
        const sheet = normalizeSheet(out.sheet) ?? prev;
        const result = applyEdits(text, out.edits);
        const patch = { sheet, gate: 'yes' };
        if (result.applied.length) {
            patch.edited = { original: text, edits: result.applied };
            message.mes = result.text;
        }
        this.setData(message, patch);
        await this.deps.persist(index, { rerender: result.applied.length > 0, save: true });
        if (result.skipped.length) console.warn('[Goldfish Therapy] edits not applied:', result.skipped);
        const n = result.applied.length;
        this.deps.status(n ? `Fixed ${n} continuity slip${n === 1 ? '' : 's'} in that reply` : 'Reply is consistent', 'ok');
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
        if (chat[index]) this.clearData(chat[index], 'edited');
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

    /** Put a fixed reply back the way the local model wrote it. */
    async restore(index) {
        const chat = this.deps.chat();
        const message = chat[index];
        const edited = this.data(message)?.edited;
        if (!edited) return false;
        message.mes = edited.original;
        this.clearData(message, 'edited');
        for (let i = index; i < chat.length; i++) this.clearData(chat[i], 'sheet', 'gate');
        await this.deps.persist(index, { rerender: true, save: true });
        return true;
    }

    /** The player says the notes are wrong: Claude rewrites them with that correction on top. */
    correct(note) {
        return this.exclusive(async () => {
            const chat = this.deps.chat();
            const last = chat.length - 1;
            if (last < 0) return null;
            const s = this.deps.settings();
            const prev = this.sheetAt(last);
            this.deps.status('Correcting the scene notes…', 'busy');
            const sheet = prev
                ? await this.advance(prev, last + 1, last, note)
                : await this.advance(null, Math.max(0, last - s.rebuildWindow + 1), last, note);
            this.setData(chat[last], { sheet, gate: 'yes' });
            await this.deps.persist(last, { rerender: false, save: true });
            this.deps.status('Scene notes corrected', 'ok');
            return sheet;
        });
    }

    /** Throw the notes away and work them out again from the recent messages. */
    rebuild() {
        return this.exclusive(async () => {
            const chat = this.deps.chat();
            const last = chat.length - 1;
            if (last < 0) return null;
            const s = this.deps.settings();
            for (const m of chat) this.clearData(m, 'sheet', 'gate');
            this.deps.status('Rebuilding the scene notes…', 'busy');
            const sheet = await this.advance(null, Math.max(0, last - s.rebuildWindow + 1), last);
            this.setData(chat[last], { sheet, gate: 'yes' });
            await this.deps.persist(last, { rerender: false, save: true });
            this.deps.status('Scene notes rebuilt', 'ok');
            return sheet;
        });
    }
}
