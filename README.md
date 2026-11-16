# Goldfish Therapy

A SillyTavern add-on for local models that lose track of the scene. It does three things:

1. **Scene notes.** A short, exact record of the physical state of the scene (where everyone is, who is tied up and how, what is in whose hands, what just changed) is kept up to date and placed in the prompt, so the local model is told the facts instead of guessing them.
2. **Reply fixing.** When a reply contradicts the notes or makes something up (using tied hands, a collar that already came off, a pencil from nowhere, a phone in a fantasy world), Claude edits just that part. The original is kept and can be put back with one click.
3. **Memory.** Every so many messages Claude writes a short chapter summary and a list of lasting facts, and those are fed back into the prompt.

Your local model still writes every reply. Claude only does the bookkeeping.

## How a turn goes

1. You send a message.
2. The local model answers one word, YES or NO: did anything physical happen in it? (About 0.3 seconds.)
3. On YES, Claude updates the scene notes. On NO, the notes stay as they are and Claude is not called.
4. The local model writes its reply with the notes and the memory in its prompt.
5. The same one-word check runs on the reply. On YES, Claude checks the reply against the notes, fixes it if needed, and updates the notes.
6. In the background, once enough messages have piled up, Claude writes a memory of the older ones.

A small line above the message box shows what it is doing. A reply that was changed gets a **✂ fixed** tag next to the name: click it to see what changed and why, and to put the original back.

## Install

In SillyTavern: Extensions, then Install extension, then paste

```
https://github.com/nsethshadburn-cloud/SillyTavern-GoldfishTherapy
```

Or copy this folder into `data/<your user>/extensions/`. To update later, press the update button next to the add-on in the Extensions list, then refresh the page.

You need:

- A Claude API key saved in SillyTavern (API Connections, Chat Completion, Claude). If you have a saved Claude connection profile, its key is used.
- A local model on a text-completion backend. The one-word check is built for KoboldCpp and llama.cpp with instruct mode on. On other setups it still works, but Claude is asked on every message.

If you use MemoryBooks or another summarizing add-on, turn it off for chats that use this one. Two memory systems spend the prompt twice and can disagree. Turn Goldfish Therapy off for Dungeon Master chats: that add-on keeps its own books.

## Settings

Extensions panel, **Goldfish Therapy**.

| Setting | What it does |
|---|---|
| On | Master switch. |
| When to ask Claude | *Only when the local model says something physical happened* is the default. *On every message* skips the local check. |
| When your message changes something physical | *Update the notes first* is the default and the most accurate: the reply waits a few seconds for Claude. *Write the reply right away* removes the wait; the notes then run one message behind and say so, and catch up after the reply. |
| Fix continuity slips in replies | Off means the notes are still kept and shown to the model, but replies are never edited. |
| Claude model | `claude-haiku-5-5` by default. |
| Write a memory every N messages | Default 12. The newest 6 messages are never summarized. |
| Scene notes depth | Where the notes sit in the prompt, counted in messages from the end. Default 1 (just before the newest message). |
| Scene notes right now | What the model is currently being told. If it is wrong, type what is true into the box under it and press Correct. |
| Rebuild from the chat | Throws the notes away and works them out again from the last 30 messages. |
| Memory of this chat | The lasting facts and chapter summaries. *Write memory now* and *Forget this chat's memory* do what they say. |

## What it costs and how long it takes

Measured on a 26B local model on KoboldCpp and `claude-haiku-5-5`:

- The local one-word check takes about 0.3 seconds and does not disturb KoboldCpp's cache. It is sent as a continuation of the prompt the last reply was written from, so only the new message is new.
- A Claude call takes 2.5 to 5 seconds.
- With the default settings, a message of yours that changes something physical delays the reply by one Claude call. Talk-only messages do not. The check on the reply happens after the reply is on screen.
- 14 Claude calls in testing cost under one cent. The panel shows a running estimate for the month.

In testing the local check got 47 of 52 messages right and never said NO to a physical one. Its mistakes are extra YES answers, which cost one small Claude call each.

## What it does not do

- It does not stop the model repeating itself or arguing in circles. That is not a state problem.
- It fixes a reply after it is on screen. If text-to-speech starts reading the moment a reply arrives, it reads the unfixed version.
- If Claude declines a message or the call fails, the reply is left exactly as written and a red note says so. Nothing is retried in a loop. The next turn picks the missed message up.
- It only reads what the chat says. If the notes are wrong, correct them in the panel.

## One thing to check in SillyTavern itself

Response Length is taken out of the context before anything else. If it is set to most of the context (for example 10,000 out of 15,000), the model only ever sees the last few messages, and no add-on can fix that. The panel warns when it is over 40 percent.

## For developers

- `src/core/` has no SillyTavern in it: the scene sheet, the exact-match editor, the memory, the prompts, and the turn logic (`engine.js`), which takes everything it needs through one `deps` object.
- `src/st/` is the wiring: `st.js` is the only file that imports SillyTavern internals.
- `npm test` runs the core tests and the turn logic against a fake chat, a fake local model and a fake Claude.
