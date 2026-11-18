# Goldfish Therapy

A SillyTavern add-on for local models that lose track of the scene. It does three things:

1. **Scene notes.** A short, exact record of the physical state of the scene (where everyone is, who is tied up and how, what is in whose hands, what just changed) is kept up to date and placed in the prompt, so the local model is told the facts instead of guessing them.
2. **Reply fixing.** When a reply contradicts the notes or makes something up (using tied hands, a collar that already came off, a pencil from nowhere, a phone in a fantasy world), Claude edits just that part. The original is kept and can be put back with one click.
3. **Memory.** Every so many messages Claude writes a short chapter summary and a list of lasting facts, and those are fed back into the prompt.

Your local model still writes every reply. Claude only does the bookkeeping.

## How a turn goes

A fresh reply is never touched. Read it, swipe it, edit it, delete it: nothing happens. A reply counts as accepted when you send your next message, and that is the only moment the add-on works:

1. You send a message.
2. The local model answers one word, YES or NO, about the reply you just accepted and about your message: did anything physical happen in it? (About 0.3 seconds each.)
3. If both are NO, the notes stay as they are and Claude is not called.
4. Otherwise one Claude call does everything: it checks the accepted reply against the notes, fixes it if needed, and brings the notes up to date with the reply and your message. If you went along with something the reply made up (you took the pencil it invented), it stays: your message is the truth of the story.
5. The local model writes its next reply from the fixed text, the notes and the memory.
6. Meanwhile, once enough messages have piled up, Claude writes a memory of the older ones.

While it works, a thin line of light sweeps along the top edge of the message box and fades when it is done. A reply that was changed pulses once and gets a small **✂ fixed** tag next to the name: click it to see what changed and why, and to put the original back. The panel shows what it last did.

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
| When you send a message and Claude is needed | *Wait for Claude* is the default and the most accurate: the next reply is written from the fixed text and current notes, a few seconds later. *Start the reply right away* removes the wait: the fix and the notes land while the reply is being written, so they only help from the following turn on. |
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
- With the default settings, sending a message delays the next reply by one Claude call when the reply before it or your message had something physical in it. A turn that is only talk is not delayed. There is at most one such call per turn, plus the memory call every so many messages, which never holds anything up.
- Swiping costs nothing: a swipe is written from the notes as they stood before the reply, and no model is asked anything.
- 14 Claude calls in testing cost under one cent. The panel shows a running estimate for the month.

In testing the local check got 47 of 52 messages right and never said NO to a physical one. Its mistakes are extra YES answers, which cost one small Claude call each.

## What it does not do

- It does not stop the model repeating itself or arguing in circles. That is not a state problem.
- It fixes a reply only after you have moved on from it. What you read first, and what text-to-speech reads, is always the reply as the model wrote it.
- It does not fix a reply you edited by hand, or one you put back with *Put the original back*.
- If Claude declines a message or the call fails, nothing is changed and a red notice says so. Nothing is retried in a loop. The next turn picks the missed reply up.
- It only reads what the chat says. If the notes are wrong, correct them in the panel.

## One thing to check in SillyTavern itself

Response Length is taken out of the context before anything else. If it is set to most of the context (for example 10,000 out of 15,000), the model only ever sees the last few messages, and no add-on can fix that. The panel warns when it is over 40 percent.

## For developers

- `src/core/` has no SillyTavern in it: the scene sheet, the exact-match editor, the memory, the prompts, and the turn logic (`engine.js`), which takes everything it needs through one `deps` object.
- `src/st/` is the wiring: `st.js` is the only file that imports SillyTavern internals.
- `npm test` runs the core tests and the turn logic against a fake chat, a fake local model and a fake Claude.
