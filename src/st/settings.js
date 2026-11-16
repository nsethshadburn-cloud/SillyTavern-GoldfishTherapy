// Settings, saved with the rest of SillyTavern's settings.

import { ST, MODULE } from './st.js';

export const DEFAULTS = Object.freeze({
    enabled: true,
    model: 'claude-haiku-5-5',
    profileId: '',          // which saved Claude connection to borrow the key from ('' = the first Claude one)
    gateMode: 'local',      // 'local' = the local model decides when Claude is needed; 'always' = Claude sees every message
    timing: 'before',       // 'before' = notes are brought up to date before the reply is written; 'after' = no wait, notes run one message behind
    fixReplies: true,
    interval: 12,           // summarize once this many messages are old enough
    keepRecent: 6,          // the newest messages are never summarized
    memoryBudget: 2400,     // characters of chapter summaries shown to the local model
    depth: 1,               // where the scene notes sit, counted in messages from the end of the chat
    rebuildWindow: 30,      // how many recent messages Claude reads when it has no notes yet
    spend: { month: '', usd: 0, calls: 0, unpriced: 0 },
});

export function settings() {
    const all = ST.extensionSettings;
    if (!all[MODULE] || typeof all[MODULE] !== 'object') all[MODULE] = {};
    const s = all[MODULE];
    for (const [key, value] of Object.entries(DEFAULTS)) {
        if (s[key] === undefined) s[key] = structuredClone(value);
    }
    return s;
}

/** The numbers the turn logic needs, clamped to sane ranges. */
export function engineSettings() {
    const s = settings();
    const int = (value, fallback, min, max) => {
        const n = Math.round(Number(value));
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    };
    return {
        enabled: Boolean(s.enabled),
        gateMode: s.gateMode === 'always' ? 'always' : 'local',
        timing: s.timing === 'after' ? 'after' : 'before',
        fixReplies: Boolean(s.fixReplies),
        interval: int(s.interval, DEFAULTS.interval, 4, 200),
        keepRecent: int(s.keepRecent, DEFAULTS.keepRecent, 2, 50),
        memoryBudget: int(s.memoryBudget, DEFAULTS.memoryBudget, 400, 20000),
        rebuildWindow: int(s.rebuildWindow, DEFAULTS.rebuildWindow, 4, 120),
    };
}

export function save() {
    ST.saveSettingsDebounced();
}

export function connectionProfiles() {
    return ST.extensionSettings?.connectionManager?.profiles ?? [];
}

/** The saved Claude connection whose key is used, if there is one. Without one, SillyTavern's active Claude key is used. */
export function claudeProfile() {
    const s = settings();
    const claude = connectionProfiles().filter(p => p.api === 'claude');
    return claude.find(p => p.id === s.profileId) ?? claude[0] ?? null;
}

// Dollars per million tokens [input, output]. Used only for the running estimate in the panel.
const PRICES = {
    'claude-haiku-5-5': [0.10, 0.50],
    'claude-haiku-4-5': [1.00, 5.00],
    'claude-sonnet-5-5': [2.00, 10.00],
    'claude-sonnet-5': [2.00, 10.00],
    'claude-opus-5-5': [4.00, 20.00],
};

export function recordSpend(model, inputTokens, outputTokens) {
    const s = settings();
    const month = new Date().toISOString().slice(0, 7);
    if (s.spend.month !== month) s.spend = { month, usd: 0, calls: 0, unpriced: 0 };
    s.spend.calls++;
    const price = PRICES[model];
    if (price) s.spend.usd += (inputTokens * price[0] + outputTokens * price[1]) / 1e6;
    else s.spend.unpriced = (s.spend.unpriced || 0) + 1;
    save();
}
