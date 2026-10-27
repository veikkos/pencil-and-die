# The Pencil & Die

A local D&D 5e table for 2–4 players around one screen, with **Claude (in Claude Code) as the
Dungeon Master**. The only physical things are your dice: the page tells you exactly which dice to
throw and where to type the results.

- Web page at <http://localhost:4242>: party creation (name → people → calling → build preset),
  story log, pencil-sketch canvas, party cards, dice prompts and an input for actions, speech,
  questions to the DM and table talk.
- MCP server at `http://localhost:4242/mcp`: the tools Claude uses to run the game (narrate,
  request rolls, roll for monsters, update character sheets, set scenes, draw sketches, keep
  private notes, rewind).
- Everything is stored in SQLite (`data/game.db`) as an append-only event log: games,
  characters, messages, rolls, sketches, DM notes, the sketch style guide and table preferences.
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

- **Language (EN/FI):** switches the whole UI and tells the DM to narrate in that language from
  now on.
- **Complexity (Beginner / Casual / Intermediate):** applies instantly, also to past moments, so
  you can peek at the numbers underneath and switch back. The DM adapts its style to the level the
  table settles on (it isn't woken for every peek).
- **DM voice:** uses the browser's built-in speech synthesis. On macOS, Finnish works with the
  "Satu" voice (System Settings → Accessibility → Spoken Content → System voice → Manage
  voices). Choose the voice next to the toggle.
- **Scene, fights and resources:** a strip at the top shows everyone in the scene: heroes with
  their health, creatures with a health word only. During a fight it shows the turn order and
  whose turn it is. Heroes get pips for spell slots and limited abilities, and dying heroes show
  their death save pips. **When a hero falls** chooses what a third failed death save means:
  knocked out with a cost (default) or can die.
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
```

Node runs the TypeScript directly (type stripping), so there is no build step. Environment:
`PORT` (4242), `HOST` (127.0.0.1), `DB_PATH` (`data/game.db`).

| Path | What |
|---|---|
| `src/server.ts` | Express: table REST API, SSE stream, MCP endpoint |
| `src/mcp.ts` | DM tools, resources (`dnd://dm-guide`, `sketch://style`) and the `dm` prompt |
| `src/store.ts` | Event store: append, replay, rewind, preview, DM wait loop and notices |
| `src/state.ts` | Event types and the pure reducer that rebuilds game state |
| `src/rules.ts` | 5e SRD slice: races, classes, presets, character builder, check modifiers |
| `src/dice.ts` | Dice notation, advantage, validating physical results |
| `src/sketch.ts` | Sketch style guide and SVG sanitizing |
| `src/dm-guide.ts` | Instructions Claude follows as DM |
| `public/` | The page (vanilla JS modules, no build) |
| `stories/` | Storybook: the real page in a frame, fed by `stories/fixtures/data.json`. After engine or API changes, `npm run storybook:fixtures` replays the scenes on a throwaway server and rewrites it |
