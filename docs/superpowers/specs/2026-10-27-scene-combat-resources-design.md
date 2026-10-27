# Scene roster, combat tracker, resources and death saves

Date: 2026-10-27 · Status: draft for review

## Why

The table (2–4 friends, mostly new to D&D, one shared screen) can already see their own heroes:
cards with HP, and a sheet with stats and inventory. Everyone else the party meets (enemies,
bystanders, allies) and whose turn it is in a fight exist only in the DM's narration and private
notes. The player who asked for this wants to **see at a glance who is present and whose turn it
is**, with enemies, neutrals and allies clearly told apart.

There's a second reason. The DM (Claude) currently keeps initiative order, monster HP, spell
slots and once-per-rest abilities in free-text notes, and "0 HP" does nothing in the engine.
Making these real game state means the screen stays true, rewinds and restarts keep them, and
the DM has less bookkeeping to get wrong.

Success: during a fight, anyone glancing at the screen can tell who is fighting on which side,
roughly how hurt everyone is, whose turn it is and what round it is. A hero at 0 HP plays out
a tense death-save sequence without anyone needing to know the rule.

## Goals

1. **Scene roster.** Everyone present in the scene is shown in the existing bottom strip (the
   party strip), next to the heroes, colour-coded by side: enemy (red), neutral (grey),
   ally (green), hero (blue). It works outside combat too (a tavern keeper, a hooded stranger).
2. **Combat tracker.** When a fight starts, the strip re-orders into initiative order, each card
   gets a small turn number, a "Round N" badge appears, and a gold ring marks whose turn it is.
   When the fight ends, the numbers, ring and badge go away.
3. **Resources.** Limited-use abilities become counters: spell slots, Second Wind, Rage, Bardic
   Inspiration, Arcane Recovery, pact slot, Lay on Hands pool, hit dice. Hero cards show them as
   pips (● left, ○ spent). Short and long rests refill the right ones.
4. **Death saves.** A hero at 0 HP is *Dying*. The card turns red. The game itself runs the 5e
   death save rules and tells the DM what happened.
5. **"When a hero falls" table setting.** *Knocked out* (default) or *Can die*.

## Non-goals

- Grid positions, movement, ranges, opportunity attacks.
- Monster stat blocks / a bestiary. The DM still invents or recalls monster numbers; it just
  records HP and AC in the roster.
- Levelling up, and resources that scale with level. Everything is level 1 as today. Resource
  maxima can be changed by the DM by hand.
- Massive-damage instant death, exhaustion, concentration tracking.
- Spending hit dice as a dedicated flow (the DM does it with existing tools, see Resources).
- A separate turn-order bar or side column (options B and C in the mockups were rejected).

## Anti-goals (would make this a failure even if it technically works)

- **Leaking enemy numbers to the players.** Exact enemy HP, AC and DM notes must never reach
  the page, not even in the JSON. Players see only a health word.
- **Making the table do bookkeeping.** Players never advance turns or tick boxes. The DM drives
  everything through tools, and death saves are prompted automatically.
- **Breaking existing saved games.** Current campaigns must load and replay unchanged.
- **Rules jargon at the beginner level.** "Death saving throw", "initiative", "short rest" are
  fine for intermediate; beginner text uses plain words (see 7. UI copy).

## Decisions made with the user

- Layout **option A**: one strip for everyone; during combat it re-orders into turn order.
- Death saves follow 5e and are prompted to the player as a normal physical d20 roll.
- Fallen heroes: a table setting, default **knocked out with a cost**. Alternative: **can die**.

## Design

### Constraints from the existing code

- Event-sourced: `src/state.ts` holds event types and a pure reducer, and `src/store.ts`
  appends and replays. Every new piece of state must come from events, so the timeline scrub
  and "Continue from here" rewind keep working with no extra code.
- The reducer must stay deterministic. It must **not** read table settings: settings live in
  the `settings` table and can change at any time, while replay must give the same result.
- `playerView()` in `src/state.ts` is the single place where DM-only data is stripped before
  it reaches the page.
- Table settings (`language`, `complexity`, `verbosity`) are global, stored with
  `getSetting`/`setSetting`, exposed via `/api/config` + a POST route, pushed over SSE, and
  surfaced to the DM through `takeNotices` / `get_game_state`. The new setting follows that pattern.
- UI is vanilla JS in `public/app.js` with strings in `public/i18n.js` (EN + FI). Every new
  visible string needs both languages.

### 1. Scene roster

New state: `GameState.present: Presence[]`.

```ts
interface Presence {
  id: string;            // short id, e.g. "goblin-2"; unique within the game
  name: string;          // shown to players: "Goblin", "Captive priest" (no number)
  groupId: string;       // creatures added together share it; a single creature has its own
  side: 'enemy' | 'neutral' | 'ally';
  description: string;   // shown to players when they click the card
  hp?: number; maxHp?: number;   // DM-only; optional (a shopkeeper needs none)
  ac?: number;                   // DM-only
  initiativeBonus?: number;      // DM-only; used when combat starts
  conditions: string[];          // shown to players
  notes: string;                 // DM-only
  defeated: boolean;             // true at 0 HP or when the DM says so
}
```

Events: `presence_added { presence }`, `presence_updated { presenceId, patch, reason? }`
(patch: hpDelta, hp, maxHp, ac, side, description, add/removeConditions, notes, defeated),
`presence_removed { presenceId }`.

MCP tools:
- `add_to_scene` takes one or more creatures. A `count` argument expands into separate
  creatures that share a `groupId` and the plain name ("Goblin"), with numbered ids
  (`goblin-1`, `goblin-2`) so the DM can address each one. Each has its own HP. Players
  never see the numbers.
- `update_presence` handles damage, healing, conditions, side changes (a neutral turns hostile)
  and defeat. HP reaching 0 sets `defeated: true`.
- `remove_from_scene` takes one id, a list, or `"all"` for everyone except heroes.
- `set_scene` gets an optional `present` argument. When given, it replaces the roster (heroes are
  never in the roster). When omitted, the roster is unchanged, defeated creatures included, and
  the tool result reminds the DM to update who is present if the place changed. Old games replay
  through `scene_set` unchanged because they have no roster.

**What the players see** (`playerView`): name, side, description, conditions, defeated, and a
**health word** computed server-side from hp/maxHp: Unhurt (100%), Hurt (>50%),
Bloodied (>25%), Near death (>0), Defeated (0 or `defeated`). A creature without HP shows no
word or bar. `hp`, `maxHp`, `ac`, `initiativeBonus` and `notes` are removed.

**Strip rendering** (`renderParty` in `public/app.js`): heroes first, then present creatures,
except during combat (see 2). Card border/background colour by side, as in the approved mockup
(`.superpowers/brainstorm/*/content/scene-layout.html`, option A). Creatures of the same
`groupId` with the same health word collapse into one card "Goblin ×2". When their health
words differ they split into one card per health word ("Goblin ×1 Bloodied", "Goblin ×1
Unhurt"), and these cards share the group's turn number. Clicking a creature card opens a small
modal with name, description, conditions and health word. Defeated creatures stay in the strip,
greyed and struck through, until the DM removes them or calls `set_scene` with `present`.

The DM's `get_game_state` includes the full roster with HP/AC/notes.

### 2. Combat tracker

New state: `GameState.combat: { round: number; order: CombatEntry[]; turn: number } | null`,
where `CombatEntry = { ref: { kind: 'hero'; id: string } | { kind: 'group'; groupId: string }; initiative: number }`.
A group of identical creatures shares one initiative roll and one turn, as the 5e DMG suggests:
on the group's turn, every creature in it acts. Players see the order and whose turn it is, but
not the initiative totals.

Starting a fight (`start_combat` tool, optional list of who takes part, default: all heroes and all
non-defeated enemies and allies; neutrals only if listed):
1. The engine asks every participating hero for an initiative roll: a normal physical
   `roll_requested` (d20 + DEX modifier), labelled e.g. "Initiative".
2. The engine rolls virtually once per participating group (d20 + `initiativeBonus` of its
   first creature, 0 if unknown) as a **secret** `dm_roll`, so the bonus never reaches the log.
3. While hero rolls are pending, the combat is in a *gathering* phase. The strip shows the
   "⚔ Fight!" badge and the turn numbers fill in as results arrive.
4. When the last initiative roll resolves, the order is fixed: highest first. Ties go to the
   higher DEX/bonus, then heroes before creatures. Round 1 starts with the first entry. The DM
   learns the full order through `wait_for_players`.

Recording that a roll is an initiative roll (or a death save, see 4) needs a new optional field
on `RollRequest`: `purpose?: 'initiative' | 'death_save'`. The reducer reacts to `roll_resolved`
of those purposes.

`next_turn` tool: moves the turn pointer to the next entry that can act, increments `round`
when it wraps, and returns whose turn it is. It skips defeated creatures and heroes who are
dead, stable or knocked out. Dying heroes are **not** skipped: landing on one automatically
requests their death save (see 4). The tool result says so, so the DM narrates the moment.

`add_to_combat` (or `add_to_scene` with `initiative` while a fight is on) slots a newcomer
(reinforcements) into the order. `end_combat` clears `combat`. `end_combat` is also where
knocked-out heroes come back (see 5).

UI during combat: the strip is sorted by initiative order, each card gets a small turn number,
the active card gets the gold ring, and the top bar shows "⚔ Round N". Creatures not in the
fight (e.g. a hiding neutral) go to the end without a number.

### 3. Resources

New field on `Character`:

```ts
resources: { id: string; name: string; max: number; used: number; recharge: 'short' | 'long'; unit?: 'hp' }[];
```

Defaults per class at level 1 (a table in `src/rules.ts`, applied in `buildCharacter`):

| Class | Resources |
|---|---|
| all | Hit dice: 1 (`d{hitDie}`), long rest restores half of max (min 1) |
| Fighter | Second Wind 1/short |
| Barbarian | Rage 2/long |
| Wizard | Spell slots (1st) 2/long, Arcane Recovery 1/long |
| Sorcerer, Cleric, Druid | Spell slots (1st) 2/long |
| Bard | Spell slots (1st) 2/long, Bardic Inspiration max(1, CHA mod)/long |
| Warlock | Pact slot 1/short |
| Paladin | Lay on Hands 5/long, `unit: 'hp'` (a pool, shown as "5/5", not pips) |
| Rogue, Ranger, Monk | none besides hit dice |

**Old saved games:** `character_created` events from before this change have no `resources`.
The reducer fills in the class defaults when they are missing, so replay stays deterministic and
nothing is migrated in the DB. The same applies to the new death-save and status fields.
The new 0-HP rules also apply when old events are replayed. A hero who reached 0 HP in an old game
and was never healed loads as `dying`. That's acceptable: old games have no combat, so nothing
asks for death saves automatically, and the DM can set HP or status by hand. No version marker
is needed.

Events: `resource_used { characterId, resourceId, amount }` (negative amount restores) and
`rest { kind: 'short' | 'long', characterIds }`.

MCP tools:
- `use_resource(character, resource, amount = 1)`: the resource is matched by id or name,
  case-insensitively. Using more than is left is an error, so the DM learns the hero can't.
- `rest(kind, characters?)`, default the whole party:
  - Short rest refills `recharge: 'short'` resources.
  - Long rest refills everything, restores HP to max, clears death saves, restores half the hit
    dice, and wakes knocked-out heroes.
  - Hit dice spent during a short rest are handled by the DM with existing tools: request the
    roll, then `use_resource` hit dice and `update_character` heal. The guide says how.
- `update_character` gets `resource_max` changes for hand adjustments.

UI: hero cards show each resource as a pip row (`Spell slots ●○`), or "3/5" for pools. Beginner
complexity shows resources with plain names and no "1st level" wording. The sheet modal lists
them with recharge info ("back after a short rest"). Resource names are translated in
`i18n.js` by resource id, falling back to the stored name.

### 4. Death saves

New fields on `Character`: `status: 'up' | 'dying' | 'stable' | 'out' | 'dead'` and
`deathSaves: { successes: number; failures: number }`.

Rules applied in the reducer (5e PHB):
- HP drops to 0 from `up` → `dying`, saves reset to 0/0, condition "Unconscious" added.
- Death save roll resolved (`purpose: 'death_save'`, plain d20, no modifier):
  - natural 20: HP 1, `up`, saves cleared, Unconscious removed.
  - natural 1: +2 failures.
  - 10 or higher: +1 success. Below 10: +1 failure.
  - 3 successes → `stable` (still 0 HP, unconscious, no more saves).
  - 3 failures → the hero has *fallen*. See 5 for what happens next.
- Damage taken while `dying` or `stable`: +1 failure (+2 if the DM marks it `critical`), and
  `stable` goes back to `dying`. `update_character` gets an optional `critical` flag.
- Any healing above 0 → `up`, saves cleared, Unconscious removed.

Prompting: when a dying hero's turn comes up in combat, `next_turn` requests the death save
automatically. Outside combat, the DM calls `request_roll` with `check: "death save"`, which
maps to `purpose: 'death_save'`, 1d20, no modifier, no DC shown.

UI: the dying card turns red with "Dying" and two pip rows, "Saves ●●○" and "Fails ●○○", as in
the mockup (`resources-dying.html`). Stable shows "Stable". Dead shows a muted card with ✝ and
"Fallen". Knocked out shows "Knocked out". The roll prompt for a death save uses
plain words at the beginner level ("Mira is fading. Roll a d20: 10 or more and she holds on.").

### 5. "When a hero falls" setting

A global table setting `fallenHeroes: 'knockout' | 'death'`, default `'knockout'`. It is a
select next to verbosity/complexity/language in the top bar ("When a hero falls: Knocked out /
Can die"), wired like `verbosity`: getter/setter in `GameStore`, `/api/config`, POST route, SSE
push, a DM notice when it changes, shown in `get_game_state`.

Because the reducer may not read settings, the outcome of a third failed save is recorded as
its own event. After appending a `roll_resolved` (or damage) that leaves a hero with 3 failures,
the store immediately appends `hero_fell { characterId, outcome: 'dead' | 'knocked_out' }`, with
the outcome taken from the current setting. The reducer sets `status` to `dead` or `out`
accordingly. Replays read the recorded outcome, so changing the setting later never rewrites
history.

- **Knocked out:** the hero stays at 0 HP with status `out` and is skipped in turn order. When
  `end_combat` is called, or on a long rest, or on any healing, they come back at 1 HP, `up`.
  The DM gets a notice: *"Mira was knocked out, not killed. When the fight is over, she wakes
  with 1 HP. Narrate a cost that fits the story: captured, robbed of an item, a lasting injury,
  the enemy escapes or gains ground. Record it with update_character / a DM note."*
- **Can die:** status `dead`. Healing no longer helps (only story magic, which is a DM call via
  `update_character` with an explicit `revive` flag). The DM is told to narrate the death with care.

Both `hero_fell` and every death-save result reach the DM through `wait_for_players` (add
`hero_fell` to `isPlayerEvent`, and describe it in `describeEvent`).

### 6. DM guide

Update `src/dm-guide.ts`:
- Combat: `add_to_scene` (with HP, AC, initiative bonus) → `start_combat` → narrate each turn →
  `next_turn` after each one. Use `update_presence` for enemy damage instead of DM notes.
  `end_combat` when it's over.
- Roster: keep `present` true to the fiction. Use `set_scene` with `present` when moving.
- Resources: `use_resource` whenever a hero casts a levelled spell or uses a limited feature.
  `rest` when the party rests. How to spend hit dice on a short rest.
- Death saves are automatic in combat. Narrate the tension, never the mechanics, at beginner
  level. React to `hero_fell` according to the table setting.

### 7. UI copy

There is no pre-approved string list. The builder writes it in EN and FI, following these rules:

| Level | Style | Examples |
|---|---|---|
| beginner | plain words, no numbers beyond HP | "Fight!", "Round 2", "Mira's turn", "Uses left", "Back after a short break" / "…a night's sleep", "Fading", "Holding on" / "Slipping" pips, "Out cold", "Fallen" |
| casual | light terms, numbers OK | "Initiative", "Spell slots", "Short rest" / "Long rest", "Dying", "Saves" / "Fails" |
| intermediate | standard 5e terms | "Death saving throw", "1st-level spell slots", "Hit dice (d8)" |

Health words (all levels): Unhurt, Hurt, Bloodied, Near death, Defeated. Setting label: "When a
hero falls: Knocked out / Can die". Beginner death-save prompt: "Mira is fading. Roll a d20: 10 or
more and she holds on."

## Testing

`node:test` in `test/`:
- Reducer: roster add/update/remove, health word thresholds, `playerView` strips hidden
  fields (assert on the JSON, not just the UI).
- Combat: initiative gathering → order (including ties), `next_turn` skipping and round wrap,
  auto death-save request on a dying hero's turn, newcomer insertion, `end_combat`.
- Resources: class defaults, use/restore, over-use error, short vs long rest, hit dice half.
- Death saves: every branch (nat 1, nat 20, 3 successes, 3 failures, damage while down,
  critical damage, healing), `hero_fell` outcome per setting, replay after a setting change
  gives the recorded outcome.
- Backward compatibility: replay a game whose `character_created` lacks the new fields.
- Rewind across combat start/end and across a `hero_fell`.

## Left to the builder

- Exact tool names and argument shapes, as long as they match the behaviour above and the style
  of `src/mcp.ts` (zod schemas, short descriptions, plain-text results).
- Event names and how events are split, within the determinism constraint.
- CSS details, as long as they match the mockups and work in dark mode (`7f0358f`).
- Finnish wording (follow the tone of the existing `i18n.js`).
- Whether the "Fight!" gathering phase shows any extra hint while initiative rolls are pending.

## Calls I made (not discussed with the user)

- The roster works outside combat, not only in fights.
- Enemies show a health word and bar, never exact HP. The thresholds are listed above.
- Identical creatures added together form a group: separate HP, one shared initiative and turn,
  one "×N" card (split by health word). Players see "Goblin", never "Goblin 2".
- `set_scene` only replaces the roster when told to. Defeated creatures stay until then.
- Initiative is gathered automatically by the engine when combat starts. Creature rolls are
  secret, and players never see initiative totals.
- Old games replay with the new 0-HP rules. No version marker.
- UI copy is written by the builder, following the three-level style table.
- Knocked-out heroes come back at combat end, on a long rest or on healing, and the DM
  chooses the cost.
- "When a hero falls" is global like the other table settings, not per game.
