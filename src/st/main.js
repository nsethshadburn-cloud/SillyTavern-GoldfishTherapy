// Wires the turn logic into SillyTavern: the hooks, the prompt notes, and what the user sees.

import { ST, MODULE } from './st.js';
import { settings, engineSettings, save, connectionProfiles, DEFAULTS } from './settings.js';
import { localGate, callClaude, expectChatPrompt, forgetChatPrompt, onCombinePrompts, onTextGenSettings } from './llm.js';
import { Engine } from '../core/engine.js';
import { normalizeMemory, renderMemory, emptyMemory } from '../core/memory.js';
import { renderSheet } from '../core/sheet.js';
import { applyEdits } from '../core/edits.js';

const SHEET_KEY = 'goldfish_therapy_sheet';
const MEMORY_KEY = 'goldfish_therapy_memory';
const NAME = 'Goldfish Therapy';

let engine;
const checkedMemory = new WeakSet();

// ---------------- what the turn logic needs from SillyTavern ----------------

function memory() {
    const meta = ST.chatMetadata;
    if (!meta[MODULE] || !checkedMemory.has(meta[MODULE])) {
        meta[MODULE] = normalizeMemory(meta[MODULE]);
        checkedMemory.add(meta[MODULE]);
    }
    return meta[MODULE];
}

function cast() {
    const character = ST.character;
    const persona = String(ST.powerUser?.persona_description ?? '').trim();
    const parts = [];
    if (character?.description) parts.push(String(character.description).trim());
    if (character?.scenario) parts.push(`Scenario: ${String(character.scenario).trim()}`);
    if (persona) parts.push(`The player's character (${ST.userName}): ${persona.slice(0, 600)}`);
    return {
        charName: character?.name || ST.charName || 'the character',
        userName: ST.userName || 'the player',
        card: ST.substituteParams(parts.join('\n\n')),
    };
}

function inject(sheetText, memoryText) {
    const depth = Math.max(0, Math.round(Number(settings().depth)) || 0);
    ST.setExtensionPrompt(SHEET_KEY, sheetText || '', ST.promptTypes.IN_CHAT, depth, false, ST.promptRoles.SYSTEM);
    ST.setExtensionPrompt(MEMORY_KEY, memoryText || '', ST.promptTypes.IN_PROMPT, 0, false, ST.promptRoles.SYSTEM);
}

async function persist(index, { rerender, save: saveNow }) {
    const message = ST.chat[index];
    if (!message) return;
    ST.syncMesToSwipe(index);
    if (rerender) {
        ST.updateMessageBlock(index, message);
        glow(index);
    }
    // While a reply is being written, SillyTavern saves the chat itself when the reply is done.
    if (saveNow && !ST.isBusy) await ST.saveChat();
    refreshBadges();
}

/** A soft pulse on a reply whose text was just fixed, so the change does not look like a glitch. */
function glow(index) {
    const el = document.querySelector(`#chat .mes[mesid="${index}"]`);
    if (!el) return;
    el.classList.remove('gft-glow');
    void el.offsetWidth;
    el.classList.add('gft-glow');
    setTimeout(() => el.classList.remove('gft-glow'), 2200);
}

/**
 * SillyTavern hands add-ons copies of the messages for the prompt it is about to build, made before
 * our hook runs. A reply fixed inside the hook has to be fixed in its copy too, or the model would
 * still be shown the unfixed text this turn.
 */
function patchPromptCopies(copies, fixes) {
    if (!Array.isArray(copies)) return;
    for (const fix of fixes) {
        const source = ST.chat[fix.index];
        if (!source) continue;
        let copy = null;
        for (let i = copies.length - 1; i >= 0 && !copy; i--) {
            const c = copies[i];
            if (!c || c.is_user) continue;
            if ((c.extra && c.extra === source.extra) || (c.send_date === source.send_date && c.name === source.name)) copy = c;
        }
        if (!copy) {
            console.warn(`[${NAME}] the fixed reply was not found among the prompt messages; this one prompt uses the unfixed text`);
            continue;
        }
        copy.mes = copy.mes === fix.original ? fix.text : applyEdits(copy.mes, fix.edits).text;
    }
}

// ---------------- the activity line ----------------
//
// A hairline of light on the top edge of the message box: it sweeps while something is being
// worked out and fades when it is done. No text. What it last did is written in the panel.
// A failure also raises SillyTavern's own red notice, because a failure must not go unseen.

let statusTimer = null;
let lastStatus = null;

function status(text, kind) {
    let el = document.getElementById('gft_status');
    if (!el) {
        el = document.createElement('div');
        el.id = 'gft_status';
        el.setAttribute('aria-hidden', 'true');
        el.appendChild(document.createElement('span'));
        (document.getElementById('form_sheld') ?? document.body).prepend(el);
    }
    el.dataset.kind = kind;
    el.classList.add('gft-show');
    clearTimeout(statusTimer);
    if (kind !== 'busy') statusTimer = setTimeout(() => el.classList.remove('gft-show'), kind === 'error' ? 6000 : 700);
    if (kind === 'error') toastr.error(text, NAME, { timeOut: 12000 });
    if (kind === 'warn') console.warn(`[${NAME}] ${text}`);
    lastStatus = { text, kind, at: new Date() };
    if (kind !== 'busy') refreshPanel();
    else refreshLast();
}

function refreshLast() {
    const el = document.getElementById('gft_last');
    if (!el) return;
    if (!lastStatus) {
        el.textContent = '';
        return;
    }
    const time = lastStatus.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    el.textContent = `Last activity (${time}): ${lastStatus.text}`;
    el.dataset.kind = lastStatus.kind;
}

// ---------------- the "fixed" badge on edited replies ----------------

function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function refreshBadges() {
    for (const el of document.querySelectorAll('#chat .mes')) {
        const index = Number(el.getAttribute('mesid'));
        const edited = ST.chat[index]?.extra?.goldfish?.edited;
        const badge = el.querySelector('.gft-badge');
        if (edited && !badge) {
            const b = document.createElement('span');
            b.className = 'gft-badge';
            b.title = 'Goldfish Therapy fixed a continuity slip in this reply. Click to see what changed.';
            b.textContent = '✂ fixed';
            (el.querySelector('.ch_name') ?? el.querySelector('.mes_block') ?? el).appendChild(b);
        } else if (!edited && badge) {
            badge.remove();
        }
    }
}

async function showEdits(index) {
    const edited = ST.chat[index]?.extra?.goldfish?.edited;
    if (!edited) return;
    const rows = edited.edits.map(e => `
        <div class="gft-edit">
            <div><b>Was:</b> <span class="gft-was">${escapeHtml(e.find)}</span></div>
            <div><b>Now:</b> ${e.replace ? `<span class="gft-now">${escapeHtml(e.replace)}</span>` : '<i>(removed)</i>'}</div>
            ${e.why ? `<div class="gft-why">${escapeHtml(e.why)}</div>` : ''}
        </div>`).join('');
    const html = `<div class="gft-popup"><h3>What Goldfish Therapy changed</h3>${rows}</div>`;
    const RESTORE = 2;
    const result = await ST.callGenericPopup(html, ST.POPUP_TYPE.TEXT, '', {
        okButton: 'Keep the fix',
        customButtons: [{ text: 'Put the original back', result: RESTORE }],
        wide: true,
        allowVerticalScrolling: true,
    });
    if (result === RESTORE && await engine.restore(index)) {
        toastr.info('The reply is back the way it was written.', NAME);
    }
}

// ---------------- settings panel ----------------

const PANEL = `
<div id="gft_panel" class="gft-panel">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>🐟 Goldfish Therapy</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <label class="checkbox_label"><input type="checkbox" id="gft_enabled"><span>On</span></label>
      <div id="gft_warning" class="gft-warning"></div>

      <label for="gft_gate">When to ask Claude</label>
      <select id="gft_gate" class="text_pole">
        <option value="local">Only when the local model says something physical happened (fast, cheaper)</option>
        <option value="always">On every message (most thorough)</option>
      </select>

      <label for="gft_timing" title="Nothing is touched while a reply is fresh. When you send your next message, the reply before it is checked and the notes are brought up to date.">When you send a message and Claude is needed</label>
      <select id="gft_timing" class="text_pole">
        <option value="before">Wait for Claude, then write the reply (most accurate, adds a few seconds)</option>
        <option value="after">Start the reply right away (no wait; the fix and the notes land while it is being written, so they help from the next turn on)</option>
      </select>

      <label class="checkbox_label" title="When a reply contradicts the scene notes or makes something up, Claude edits just that part. The original is kept and can be put back.">
        <input type="checkbox" id="gft_fix"><span>Fix continuity slips in replies</span>
      </label>

      <div class="gft-row">
        <div><label for="gft_model">Claude model</label><input id="gft_model" class="text_pole" type="text" placeholder="${DEFAULTS.model}"></div>
        <div id="gft_profile_wrap"><label for="gft_profile">Claude connection (for the key)</label><select id="gft_profile" class="text_pole"></select></div>
      </div>
      <div class="gft-row">
        <div><label for="gft_interval" title="Once this many messages have scrolled past the newest few, Claude writes a memory of them.">Write a memory every N messages</label><input id="gft_interval" class="text_pole" type="number" min="4" max="200"></div>
        <div><label for="gft_depth" title="Where the scene notes sit in the prompt, counted in messages from the end. 1 = just before the newest message.">Scene notes depth</label><input id="gft_depth" class="text_pole" type="number" min="0" max="10"></div>
      </div>

      <h4>Scene notes right now</h4>
      <pre id="gft_sheet" class="gft-box"></pre>
      <div id="gft_pending" class="gft-spend"></div>
      <div class="gft-row">
        <input id="gft_correction" class="text_pole" type="text" placeholder="Wrong? Say what is true, e.g. she is not tied up any more">
        <div class="menu_button gft-btn" id="gft_correct">Correct</div>
      </div>
      <div class="gft-row">
        <div class="menu_button gft-btn" id="gft_rebuild" title="Throw the notes away and work them out again from the recent messages.">Rebuild from the chat</div>
      </div>

      <h4>Memory of this chat</h4>
      <pre id="gft_memory" class="gft-box"></pre>
      <div class="gft-row">
        <div class="menu_button gft-btn" id="gft_summarize" title="Write a memory of everything except the newest few messages now.">Write memory now</div>
        <div class="menu_button gft-btn" id="gft_forget" title="Delete this chat's memory. The chat itself is not touched.">Forget this chat's memory</div>
      </div>

      <div id="gft_last" class="gft-spend"></div>
      <div id="gft_spend" class="gft-spend"></div>
    </div>
  </div>
</div>`;

function refreshPanel() {
    if (!document.getElementById('gft_panel') || !engine) return;
    const s = settings();
    const last = ST.chat.length - 1;
    const sheet = last >= 0 ? engine.sheetAt(last) : null;
    $('#gft_sheet').text(sheet ? renderSheet(sheet) : 'No notes yet. They are written when the next message is sent.');
    const fresh = last > 0 && engine.unchecked(ST.chat[last]);
    $('#gft_pending').text(fresh && sheet ? 'The newest reply is not counted yet. It is checked and added when you send your next message.' : '');
    refreshLast();
    const mem = memory();
    $('#gft_memory').text(renderMemory(mem, '', 1e9) || 'Nothing yet. The first memory is written once the chat is long enough.');

    const reserve = ST.responseLength;
    const context = ST.maxContext;
    const warning = $('#gft_warning');
    if (context && reserve / context > 0.4) {
        warning.text(`Heads up: your Response Length is ${reserve} of a ${context}-token context. That leaves only about ${context - reserve} tokens for the card, the notes and the chat itself, so the model sees very few recent messages. Lowering Response Length gives it far more to work with.`).show();
    } else {
        warning.hide();
    }

    const spend = s.spend;
    const month = new Date().toISOString().slice(0, 7);
    const live = spend.month === month ? spend : { usd: 0, calls: 0, unpriced: 0 };
    const cost = live.usd < 0.01 && live.usd > 0 ? 'under $0.01' : `about $${live.usd.toFixed(2)}`;
    $('#gft_spend').text(`Claude this month: ${live.calls} call${live.calls === 1 ? '' : 's'}, ${cost}${live.unpriced ? ' (some calls used a model with no known price)' : ''}. An estimate; your Anthropic console has the real figure.`);
}

function buildPanel() {
    $('#extensions_settings2').append(PANEL);
    const s = settings();
    $('#gft_enabled').prop('checked', s.enabled).on('change', function () {
        s.enabled = this.checked;
        if (!s.enabled) inject('', '');
        save();
    });
    $('#gft_gate').val(s.gateMode).on('change', function () { s.gateMode = this.value; save(); });
    $('#gft_timing').val(s.timing).on('change', function () { s.timing = this.value; save(); });
    $('#gft_fix').prop('checked', s.fixReplies).on('change', function () { s.fixReplies = this.checked; save(); });
    $('#gft_model').val(s.model).on('input', function () { s.model = this.value.trim(); save(); });
    $('#gft_interval').val(s.interval).on('input', function () { s.interval = Number(this.value) || DEFAULTS.interval; save(); });
    $('#gft_depth').val(s.depth).on('input', function () { s.depth = Number(this.value) || 0; save(); });

    const claude = connectionProfiles().filter(p => p.api === 'claude');
    const select = $('#gft_profile');
    select.append('<option value="">First saved Claude connection</option>');
    for (const p of claude) select.append($('<option>').val(p.id).text(p.name));
    select.val(s.profileId).on('change', function () { s.profileId = this.value; save(); });
    if (claude.length < 2) $('#gft_profile_wrap').hide();

    const guard = fn => async () => {
        try {
            await fn();
        } catch (error) {
            status(String(error?.message || error), 'error');
        }
        refreshPanel();
    };
    $('#gft_correct').on('click', guard(async () => {
        const note = String($('#gft_correction').val()).trim();
        if (!note) return;
        await engine.correct(note);
        $('#gft_correction').val('');
    }));
    $('#gft_rebuild').on('click', guard(() => engine.rebuild()));
    $('#gft_summarize').on('click', guard(async () => {
        const made = await engine.summarizeNow();
        if (!made) toastr.info('Nothing old enough to summarize yet.', NAME);
    }));
    $('#gft_forget').on('click', guard(async () => {
        ST.chatMetadata[MODULE] = emptyMemory();
        ST.saveMetadataDebounced();
        toastr.info('This chat\'s memory was cleared.', NAME);
    }));
    refreshPanel();
}

// ---------------- start ----------------

export async function start() {
    engine = new Engine({
        chat: () => ST.chat,
        chatId: () => ST.chatId,
        settings: engineSettings,
        cast,
        gate: localGate,
        claude: callClaude,
        inject,
        persist,
        memory,
        saveMemory: async () => ST.saveMetadataDebounced(),
        status,
    });

    // Runs inside SillyTavern's Generate, just before the prompt is put together.
    globalThis.goldfishTherapyInterceptor = async function (_chat, _contextSize, _abort, type) {
        const kind = type || 'normal';
        try {
            const { fixes } = await engine.beforeGenerate(kind);
            patchPromptCopies(_chat, fixes);
        } catch (error) {
            console.error(`[${NAME}] before-generate hook failed`, error);
        }
        if (engineSettings().enabled && kind !== 'quiet' && kind !== 'impersonate') {
            expectChatPrompt((kind === 'swipe' || kind === 'continue') ? ST.chat.length - 1 : ST.chat.length);
        }
    };

    const on = (event, handler) => ST.eventSource.on(event, handler);
    const E = ST.eventTypes;
    on(E.GENERATE_AFTER_COMBINE_PROMPTS, onCombinePrompts);
    on(E.TEXT_COMPLETION_SETTINGS_READY, onTextGenSettings);
    // A fresh reply is left alone: it is only looked at once the player sends the next message.
    on(E.MESSAGE_RECEIVED, () => setTimeout(refreshAll, 50));
    on(E.MESSAGE_EDITED, index => engine.onEdited(Number(index)).then(refreshAll));
    on(E.MESSAGE_DELETED, length => engine.onDeleted(Number(length)).then(refreshAll));
    on(E.CHAT_CHANGED, () => {
        forgetChatPrompt();
        inject('', '');
        refreshAll();
    });
    for (const event of [E.CHARACTER_MESSAGE_RENDERED, E.USER_MESSAGE_RENDERED, E.MESSAGE_SWIPED, E.MORE_MESSAGES_LOADED]) {
        on(event, () => setTimeout(refreshBadges, 50));
    }

    $(document).on('click', '.gft-badge', function (event) {
        event.stopPropagation();
        const index = Number($(this).closest('.mes').attr('mesid'));
        showEdits(index).catch(error => status(String(error?.message || error), 'error'));
    });

    buildPanel();
    refreshBadges();
    console.log(`[${NAME}] ready`);
}

function refreshAll() {
    refreshBadges();
    refreshPanel();
}
