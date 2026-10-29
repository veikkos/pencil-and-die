# The Pencil & Die

A local D&D 5e table for 2–4 players around one screen, with **Claude (in Claude Code) as the
Dungeon Master**. The only physical things are your dice: the page tells you exactly which dice to
throw and where to type the results.

- Web page at <http://localhost:4242>: party creation (name → people → calling → build preset),
  story log, pencil-sketch canvas, scene strip, character sheets, dice prompts, level-up choices
  and an input for actions, speech, questions to the DM and table talk.
- MCP server at `http://localhost:4242/mcp`: the tools Claude uses to run the game. The engine
  keeps the numbers (modifiers, hit or miss against a creature's AC, creature HP, turn order,
  spell slots and uses, death saves, levels); Claude decides what happens and tells the story.
- Everything is stored in SQLite (`data/game.db`). Each game is an append-only event log, which
  is what makes continuing and rewinding work; settings and the sketch style guide sit beside it.
  Close it any time and continue later.

## Run it

Requires Node 24+.

```sh
npm install
npm start            # http://localhost:4242
```

Then, in another terminal **in this directory**:

```sh
claude               # approve the "dnd" MCP server from .mcp.json when asked
> /mcp__dnd__dm      # Claude reads the DM guide and starts listening to the table
```

(Elsewhere: `claude mcp add --transport http dnd http://localhost:4242/mcp`.)

Claude sits in a `wait_for_players` loop: whenever someone sends something in the page, it
wakes up, reacts through the tools, and waits again. You never need to type in the terminal.
To stop Claude asking permission for every DM action, allow the server's tools once
(choose "don't ask again" on the first prompt, or add `"mcp__dnd"` to `permissions.allow`
in `.claude/settings.local.json`).

## Playing

- **Settings (⚙):** each adventure keeps its own language, verbosity, complexity and what happens
  when a hero falls. A new adventure starts with the choices you made last; the ⚙ in the lobby
  sets those defaults.
  - **Language (EN/FI):** switches the whole page and tells the DM to narrate in that language.
  - **Complexity (Beginner / Casual / Intermediate):** applies instantly, also to past moments, so
    you can peek at the numbers underneath and switch back. The DM adapts its style to the level
    the table settles on (it isn't woken for every peek).
  - **DM voice:** the same for every adventure. It uses the browser's built-in speech synthesis.
    On macOS, Finnish works with the "Satu" voice (System Settings → Accessibility → Spoken
    Content → System voice → Manage voices).
- **Scene, fights and resources:** a strip at the top shows everyone in the scene: heroes with
  their health, creatures with a health word only. During a fight it shows the turn order and
  whose turn it is. Heroes get pips for spell slots and limited abilities, and dying heroes show
  their death save pips. **When a hero falls** (⚙) chooses what a third failed death save means:
  knocked out with a cost (default) or can die.
- **Character sheet:** tap a hero to see what they can do, what's left and what's affecting them;
  tap any number for how it adds up. When a hero has the XP and the DM calls for it, a level-up
  dialog offers the choices (up to level 5) with the recommended picks preselected.
- **Timeline:** drag the slider to see the game at any earlier moment (story, sheets, sketch,
  pending rolls). Nothing changes until you press **Continue from here**. That cuts off
  everything after that point and the DM is told to carry on from there. Use it to fix a mistyped
  roll, take back an action, or replay a scene.
- **Sketches:** the DM draws in a shared pencil style (`get_sketch_style`, stored in the DB so
  every future Claude session draws the same way). New sketches take over the canvas; browse
  older ones with ‹ ›.

## Development

```sh
npm run dev          # restart on change
npm test             # node:test
npm run typecheck
npm run storybook    # the page's screens and overlays at http://localhost:6006
npm run dm-report -- <game id>   # where the DM drifted from the guide in a saved game
```

Node runs the TypeScript directly (type stripping), so there is no build step. Environment:
`PORT` (4242), `HOST` (127.0.0.1), `DB_PATH` (`data/game.db`).

| Path | What |
|---|---|
| `src/server.ts` | Express: table REST API, SSE stream, MCP endpoint |
| `src/mcp.ts` | DM tools, resources (`dnd://dm-guide`, `sketch://style`) and the `dm` prompt |
| `src/mcp-scene.ts` | DM tools for the scene roster, combat, resources and rests |
| `src/store.ts` | Event store: append, replay, rewind, preview, per-adventure settings, DM wait loop and notices |
| `src/state.ts` | Event types and the pure reducer that rebuilds game state |
| `src/rules.ts` | 5e SRD slice: races, classes, presets, character builder, check modifiers |
| `src/sheet.ts` | The sheet's numbers, computed from the character: attacks, damage, spells, skills |
| `src/levels.ts` | Levels 2–5 per class: what the rules give and the choices players make |
| `src/spells.ts`, `src/weapons.ts`, `src/armour.ts` | SRD data |
| `src/roster.ts`, `src/combat.ts` | Creatures in the scene; initiative and turn order |
| `src/resources.ts`, `src/life.ts` | Spell slots, uses and rests; dying, death saves and falling |
| `src/dice.ts` | Dice notation, advantage, validating physical results, hit or miss |
| `src/sketch.ts` | Sketch style guide and SVG sanitizing |
| `src/dm-guide.ts` | Instructions Claude follows as DM |
| `src/dm-report.ts` | Drift checks on a game's events: narration length, scenes, damage by hand, numbers in notes |
| `public/` | The page (vanilla JS modules, no build) |
| `stories/` | Storybook: the real page in a frame, fed by `stories/fixtures/data.json`. After engine or API changes, `npm run storybook:fixtures` replays the scenes on a throwaway server and rewrites it |
