// Every prompt the add-on sends, in one place.

const MAX_MESSAGE_CHARS = 3000;

const SHEET_FORMAT = `The sheet is JSON in exactly this shape:
{
  "place": "where the scene is, short",
  "time": "time of day and how long since the story began, short",
  "world": "one line: the kind of world and its technology level",
  "people": {
    "Name": {
      "position": "posture and where exactly, short",
      "restraints": ["one entry per restraint: what it is, where on the body, how it is fastened"],
      "wearing": ["clothing and worn items that matter"],
      "holding": ["only what is in their hands right now"],
      "condition": ["injuries, exhaustion, lasting bodily effects"]
    }
  },
  "things": ["notable objects in the scene and where each one is"],
  "recent": ["up to 4 short notes on physical facts that changed in the last few messages, most recent last"]
}`;

const SHEET_RULES = `Rules for the sheet:
- Record only what the messages establish. Never invent or assume. Leave a field empty when the story has not said.
- Messages marked (player) are the truth of the story, including when the player narrates what happens to another character.
- Restraints are exact. A restraint that comes off leaves "restraints", and "recent" gets a plain note such as "the collar came off and is no longer on her". A restraint that is loosened but still on stays, with the change described.
- "holding" is only what is in hand now. Something put down or taken away moves to "things" or to the other person.
- When the place changes, drop the things left behind and update positions. When time jumps, update "time".
- "world" comes from the character card and the story so far. Keep it stable once set.
- "recent" notes are for the last few messages only: at most 3, newest last. Drop a note once it is old.
- "position" is posture and location only.
- Keep every entry literal and at most 12 words. No feelings, no dialogue, no plot.
- Write compact JSON on one line and leave out any field that is empty. Speed matters: the player is waiting.`;

function clip(text, max = MAX_MESSAGE_CHARS) {
    const s = String(text ?? '').trim();
    return s.length > max ? `${s.slice(0, max)} [...]` : s;
}

/**
 * @param {Array<{index:number, name:string, isUser:boolean, text:string}>} messages
 */
export function transcript(messages) {
    return messages.map(m => `[#${m.index} ${m.name} ${m.isUser ? '(player)' : '(character)'}]\n${clip(m.text)}`).join('\n\n');
}

function castBlock(cast) {
    const lines = [`The AI-written character is ${cast.charName}. The human player's character is ${cast.userName}; the player may also voice other characters and narrate.`];
    if (cast.card) lines.push(`CHARACTER CARD (background only):\n${clip(cast.card, 2200)}`);
    return lines.join('\n\n');
}

/** Bring the sheet up to date with new messages (or build it from nothing). */
export function buildAdvance({ cast, sheet, context, messages, correction = '' }) {
    const system = `You keep the continuity record for a roleplay between a human player and an AI-written character. You never write story text and never comment on the story. Your whole job is a small, exact record of the physical state of the scene, so the story stays consistent.

${SHEET_FORMAT}

${SHEET_RULES}

Reply with JSON only: {"sheet": { ... }}`;
    const parts = [castBlock(cast)];
    parts.push(sheet ? `CURRENT SHEET (true before the new messages):\n${JSON.stringify(sheet)}` : 'There is no sheet yet. Build it from the messages below.');
    if (context.length) parts.push(`EARLIER MESSAGES (context only, already counted in the sheet):\n${transcript(context)}`);
    if (messages.length) parts.push(`NEW MESSAGES:\n${transcript(messages)}`);
    if (correction) parts.push(`CORRECTION FROM THE PLAYER (this overrides the sheet and the messages):\n${clip(correction, 800)}`);
    parts.push('Return the sheet as it stands after all of the above.');
    return { system, user: parts.join('\n\n') };
}

/**
 * Check one reply from the AI-written character against the sheet, fix it, and update the sheet.
 * `after` holds the messages that followed the reply (usually the player's next one): they are
 * never edited, only folded into the sheet.
 */
export function buildCheck({ cast, sheet, context, reply, after = [] }) {
    const system = `You are the continuity editor for a roleplay between a human player and an AI-written character (${cast.charName}). A small local model writes ${cast.charName}'s replies and it loses track of physical facts. You check one of its replies against the record and repair it with the smallest possible edits. You never judge the story's content or style.

WHAT COUNTS AS AN ERROR
1. Impossible action: the reply has someone do what their state on the sheet rules out (using hands that are tied behind the back, walking with bound legs, speaking clearly through a gag).
2. Wrong state: a restraint, worn item or held item is described as on when the sheet says it is off, or off when it is on; a position, place or time that contradicts the sheet; an event described as if it had not happened yet, or happening a second time.
3. Not hers to change: ${cast.charName} alters something another character controls (loosens or removes a restraint someone else fastened without a way to do it, ends a spell cast on her, undoes the other character's action). She MAY change her own state through actions that are physically possible for her right now: that is not an error, record it on the sheet.
4. Made-up things: an object, piece of furniture or item of clothing that was never established and that she touches, uses, holds or treats as important. Ordinary background that fits the place (a tree in a forest, a counter in a kitchen) is fine when it is only scenery.
5. Wrong world: technology, brands, religion or other details that cannot exist in the world described on the sheet.

NOT ERRORS, leave alone: emotions, dialogue, opinions, repetition, pacing, word choice, anything the sheet is silent about that is plausible. When the reply carries through an action the player's character had already started in the previous message, accept it and record it.

HOW TO EDIT
- Each edit replaces one exact piece of the reply. "find" must be copied character for character from the reply, long enough to be unique, and as short as the fix allows.
- Prefer cutting the wrong clause or sentence. When cutting would leave a hole, reword just enough to fit the sheet (for example "wipes her mouth with the back of her wrist" with tied hands becomes "wipes her mouth against her shoulder").
- Never add new events, objects or dialogue. Keep the reply's voice, tense and formatting (asterisks around actions, quotes around speech).
- "why" is one short plain sentence for the player.
- If the reply is consistent, return an empty edits list. Most replies need no edit.

MESSAGES AFTER THE REPLY
Sometimes the messages that came after the reply are shown too. They are already part of the story. Never edit them and never put text from them in "find".
- Judge the reply only against the sheet and what came before it, never against what comes after.
- If a later message from the player goes along with something in the reply (uses the object, answers the action, builds on it), the player has accepted it: it is part of the story now. Do not edit it out; record it on the sheet.
- The sheet you return is the state after the LAST message shown, so fold the later messages in.

${SHEET_FORMAT}

${SHEET_RULES}

Reply with JSON only:
{"edits": [{"find": "...", "replace": "...", "why": "..."}], "sheet": { the sheet as it stands after the last message shown, with your edits applied }}`;
    const parts = [
        castBlock(cast),
        `SHEET (true before the reply):\n${JSON.stringify(sheet)}`,
    ];
    if (context.length) parts.push(`RECENT MESSAGES (already counted in the sheet):\n${transcript(context)}`);
    parts.push(`THE REPLY TO CHECK:\n${transcript([reply])}`);
    if (after.length) parts.push(`MESSAGES AFTER THE REPLY (not to be edited, only folded into the sheet):\n${transcript(after)}`);
    return { system, user: parts.join('\n\n') };
}

/** Summarize a stretch of the chat into one chapter and revise the lasting facts. */
export function buildSummarize({ cast, facts, earlier, messages }) {
    const system = `You keep the long-term memory for a roleplay between a human player and an AI-written character. A small local model writes the character and forgets what happened once it scrolls out of view. You write what it needs to remember. You never judge the story.

Write only about the characters and the story, by character name. Never mention the player, "the user", or that this is a roleplay.

Write:
- "summary": at most 110 words, past tense, concrete. Who did what to whom, where, what changed, and any promise, threat, deal, rule or revelation. Use names. No commentary.
- "keywords": 8 to 12 lowercase words or names someone would use when this part of the story comes up again.
- "facts": the full revised list of lasting facts, at most 20, each at most 20 words. Lasting facts stay true and matter later: who people are, relationships, deals and debts, promises, places, powers, permanent changes to a body or a situation. Start from the existing list: keep what still holds, fix what changed, add what is new, drop what stopped being true. Momentary physical state (who is sitting where, what is in whose hand) does not belong here.

Reply with JSON only: {"summary": "...", "keywords": ["..."], "facts": ["..."]}`;
    const parts = [castBlock(cast)];
    parts.push(`EXISTING LASTING FACTS:\n${facts.length ? facts.map(f => `- ${f}`).join('\n') : '(none yet)'}`);
    if (earlier.length) parts.push(`EARLIER CHAPTERS (for continuity, do not repeat them):\n${earlier.map(s => `- ${s}`).join('\n')}`);
    parts.push(`MESSAGES TO SUMMARIZE:\n${transcript(messages)}`);
    return { system, user: parts.join('\n\n') };
}

// ---- The local model's one-word check ----

// Wording and examples were tuned against the real local model (Pantheon-Reasoning 26B on KoboldCpp):
// 47 of 52 test messages right, and none of the 31 physical ones missed. Without the examples
// the model answers YES to everything; with a bare "look at the last message" it answers at random.

/** Goes between the chat and the question, so the model stops playing its character. */
export const GATE_PAUSE = '[The story is paused. The next request is a separate task and is not part of the story.]';

const GATE_EXAMPLES = [
    ['*He unties her ankles.*', 'YES'],
    ['"Why are you doing this?"', 'NO'],
    ['*She picks up the cup and drinks.*', 'YES'],
    ['*Her eyes narrow.* "I do not believe you."', 'NO'],
    ['*The cuffs are still locked around her wrists as she speaks.* "Let me go."', 'YES'],
    ['I told you already. We leave at dawn.', 'NO'],
    ['*She gets to her feet and walks to the window.*', 'YES'],
    ['*She sighs, voice trembling.* "Fine. Whatever you say."', 'NO'],
];

/** The one-word question about one message. */
export function gateQuestion(message) {
    const examples = GATE_EXAMPLES.map(([m, a]) => `MESSAGE: ${m}\nANSWER: ${a}`).join('\n\n');
    return 'You sort roleplay messages for a continuity checker. Answer with exactly one word: YES or NO.\n\n' +
        'Does anything physical happen in the message? Physical means: a body moves or is moved, hands or limbs do something, ' +
        'an object is touched, used, given, held or mentioned as worn, a restraint is put on, taken off or mentioned, someone is hurt, the place or time changes. ' +
        'Facial expressions, ears, eyes, tears, breathing, tone of voice and feelings do NOT count. If unsure answer YES.\n\n' +
        `${examples}\n\nMESSAGE: ${clip(message, 2000).replace(/\s*\n+\s*/g, ' ')}\nANSWER:`;
}

/** YES unless the model clearly said NO: a wrong YES costs one small Claude call, a wrong NO hides an error. */
export function parseGate(text) {
    const s = String(text ?? '').toUpperCase();
    const yes = s.search(/\bYES\b/);
    const no = s.search(/\bNO\b/);
    if (no !== -1 && (yes === -1 || no < yes)) return false;
    return true;
}
