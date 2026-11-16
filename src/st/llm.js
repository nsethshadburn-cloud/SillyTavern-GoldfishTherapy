// Model calls: the local model's one-word check, and Claude.
// Claude goes through SillyTavern's own backend, so the saved API key is used and never exposed.

import { ST } from './st.js';
import { settings, claudeProfile, recordSpend, DEFAULTS } from './settings.js';
import { GATE_PAUSE, gateQuestion, parseGate } from '../core/prompts.js';

// ---------------- The local one-word check ----------------
//
// KoboldCpp keeps one prompt in its cache. A check sent as a fresh little prompt throws the chat
// out of that cache, and the next reply has to re-read the whole chat (measured: 2.4 s at 10k tokens).
// So the check is sent as a continuation of the exact prompt the last reply was written from:
// only the new message and the question are new, and the chat stays cached (measured: 0.16 s).

const GATE_GRAMMAR = 'root ::= "YES" | "NO"';
const RIDE_MAX_TAIL = 6;

let captured = null;   // { prompt, forIndex, chatId }: the last real chat prompt, and which message it was written for
let expecting = null;  // { forIndex, chatId }: set when a real reply is about to be generated
let gateCall = null;   // { prefix } while one of our own checks is in flight

/** Called from the generate interceptor: the next prompt SillyTavern builds is a real chat prompt. */
export function expectChatPrompt(forIndex) {
    expecting = { forIndex, chatId: ST.chatId };
}

export function forgetChatPrompt() {
    captured = null;
    expecting = null;
}

/** GENERATE_AFTER_COMBINE_PROMPTS: remember real chat prompts, and put ours on top of the remembered one. */
export function onCombinePrompts(eventData) {
    if (!eventData || eventData.dryRun || typeof eventData.prompt !== 'string') return;
    if (gateCall) {
        if (gateCall.prefix) eventData.prompt = gateCall.prefix + eventData.prompt;
        return;
    }
    if (expecting) {
        captured = { prompt: eventData.prompt, ...expecting };
        expecting = null;
    }
}

/** TEXT_COMPLETION_SETTINGS_READY: force our check to answer YES or NO and nothing else. */
export function onTextGenSettings(params) {
    if (!gateCall || !params || typeof params !== 'object') return;
    if ('grammar' in params) params.grammar = GATE_GRAMMAR;          // KoboldCpp, llama.cpp
    else if ('grammar_string' in params) params.grammar_string = GATE_GRAMMAR;
    if ('temperature' in params) params.temperature = 0;
}

/** The remembered chat prompt up to (not including) the model's turn, plus the messages written since. */
function ride(index) {
    if (!captured || captured.chatId !== ST.chatId) return null;
    const instruct = ST.powerUser?.instruct;
    if (!instruct?.enabled) return null;
    const opener = ST.substituteParams(instruct.last_output_sequence || instruct.output_sequence || '').trimEnd();
    if (!opener) return null;
    const cut = captured.prompt.lastIndexOf(opener);
    if (cut <= 0 || captured.prompt.length - cut > opener.length + 600) return null;
    if (index < captured.forIndex || index - captured.forIndex >= RIDE_MAX_TAIL) return null;
    const tail = ST.chat.slice(captured.forIndex, index + 1).filter(m => m && !m.is_system && String(m.mes ?? '').trim());
    if (!tail.length || tail[tail.length - 1] !== ST.chat[index]) return null;
    return { prefix: captured.prompt.slice(0, cut), tail };
}

/** Remove any thinking block using the user's reasoning template. */
function withoutThinking(text) {
    let s = String(text ?? '');
    try {
        const parsed = ST.context().parseReasoningFromString?.(s, { strict: false });
        if (parsed && parsed.reasoning) s = parsed.content;
    } catch { /* keep the raw text */ }
    return s;
}

/**
 * Ask the local model: did anything physical happen in message `index`?
 * @returns {Promise<boolean>}
 */
export async function localGate(index) {
    const message = ST.chat[index];
    if (!message) return true;
    const riding = ride(index);
    // With no chat prompt to ride on (first turn after a page load, or a setup without instruct mode)
    // a standalone question would cost the chat its cache and, on the tested model, answers YES to
    // everything anyway. So Claude is asked directly.
    if (!riding) return true;
    gateCall = { prefix: riding.prefix };
    const started = Date.now();
    try {
        const prompt = riding.tail.map(m => ({ role: m.is_user ? 'user' : 'assistant', content: String(m.mes), name: m.name }));
        prompt.push({ role: 'system', content: GATE_PAUSE });
        prompt.push({ role: 'user', content: gateQuestion(message.mes) });
        const text = await ST.generateRaw({ prompt, systemPrompt: '', responseLength: 4, trimNames: false });
        const answer = parseGate(withoutThinking(text));
        console.debug(`[Goldfish Therapy] local check on #${index}: ${answer ? 'YES' : 'NO'} (${Date.now() - started} ms)`);
        return answer;
    } finally {
        gateCall = null;
    }
}

// ---------------- Claude ----------------

const CLAUDE_TIMEOUT_MS = 60000;
const CLAUDE_MAX_TOKENS = 4000;

/** SillyTavern returns {choices, content}; content is Claude's raw block list (thinking + text). */
function claudeText(json) {
    if (!json) return '';
    if (Array.isArray(json.content)) {
        const text = json.content.filter(b => b?.type === 'text' && b.text).map(b => b.text).join('\n').trim();
        if (text) return text;
    }
    return String(json?.choices?.[0]?.message?.content ?? '').trim();
}

/**
 * @param {{system:string, user:string, label:string}} p
 * @returns {Promise<string>}
 */
export async function callClaude({ system, user, label }) {
    const s = settings();
    const profile = claudeProfile();
    const model = String(s.model || '').trim() || DEFAULTS.model;
    const request = {
        stream: false,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        model,
        chat_completion_source: 'claude',
        max_tokens: CLAUDE_MAX_TOKENS,
        reasoning_effort: 'auto',   // no extra thinking asked for: these are bookkeeping calls and speed matters
        include_reasoning: false,
        use_sysprompt: true,
        secret_id: profile?.['secret-id'] || undefined,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timed out')), CLAUDE_TIMEOUT_MS);
    let json;
    try {
        json = await ST.context().ChatCompletionService.processRequest(request, {}, false, controller.signal);
    } catch (error) {
        throw new Error(`The Claude call failed (${label}): ${error?.message || error}. The SillyTavern server console has the details.`);
    } finally {
        clearTimeout(timer);
    }
    const text = claudeText(json);
    const usage = json?.usage ?? {};
    recordSpend(
        model,
        Number(usage.input_tokens) || Math.ceil((system.length + user.length) / 3.6),
        Number(usage.output_tokens) || Math.ceil(text.length / 3.6),
    );
    if (!text) throw new Error(`Claude returned nothing (${label}). It may have declined this message.`);
    return text;
}
