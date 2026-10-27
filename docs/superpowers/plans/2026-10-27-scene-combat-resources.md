# Scene Roster, Combat Tracker, Resources and Death Saves Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show everyone present in a scene (colour-coded by side) in the bottom strip, track combat turn order, model limited-use resources and run 5e death saves in the engine, with a "When a hero falls" table setting.

**Architecture:** Everything is new events folded by the existing pure reducer (`src/state.ts`), with the rules in small pure modules (`src/resources.ts`, `src/life.ts`, `src/roster.ts`, `src/combat.ts`). The only non-deterministic decision, a hero's third failed death save becoming death or a knock-out, is recorded as its own `hero_fell` event, appended by the store from the current setting. The DM drives everything through new MCP tools in a new `src/mcp-scene.ts`. `playerView()` strips everything secret before the page sees it.

**Tech Stack:** Node 24 (TypeScript via type stripping, no build), Express 5, `@modelcontextprotocol/sdk`, zod 4, SQLite event log, `node:test`, vanilla JS page.

**Spec:** `docs/superpowers/specs/2026-10-27-scene-combat-resources-design.md`

## Global Constraints

- The reducer never reads settings, time or randomness. Anything random (creature initiative) or setting-dependent (`hero_fell` outcome) is decided by the caller and stored in the event.
- Old saved games must replay. New `Character` fields are filled by `withDefaults()` on `character_created`. New optional event fields (`scene_set.present`, `RollRequest.purpose`) mean "absent = old behaviour".
- Players must never receive a creature's `hp`, `maxHp`, `ac`, `initiativeBonus`, `notes`, or any initiative total. This is enforced in `playerView()` and tested on the JSON.
- Every visible string goes in `public/i18n.js` in **both** `en` and `fi`, following spec §7 (beginner = plain words, casual = light terms, intermediate = 5e terms).
- Health words: Unhurt (hp = max), Hurt (> 50%), Bloodied (> 25%), Near death (> 0), Defeated (0 or `defeated`).
- Death saves: d20, no modifier. Nat 20 → 1 HP, up. Nat 1 → +2 failures. ≥ 10 success, < 10 failure. 3 successes → stable. 3 failures → `hero_fell`. Damage while down → +1 failure (+2 if critical).
- `fallenHeroes` setting: `'knockout' | 'death'`, default `'knockout'`, global.
- Match the style of `src/mcp.ts`: zod input schemas, one-line descriptions, plain-text results via `text()`.
- Run `npm test` and `npm run typecheck` before each commit. Both must pass.

## Review Focus

- **The DM refers to creatures sloppily** ("goblin", "Goblin", "goblin 2"). Presence lookup must accept an id or a case-insensitive name, and when a name matches several living creatures it must error and list their ids rather than pick one. Test lives in Task 4.
- **Initiative roll cancelled or the hero is removed mid-gathering.** Combat must not hang in the gathering phase. A cancelled initiative roll drops that hero from the order, and the fight starts once the remaining ones are in. Test lives in Task 5.
- **Everyone on one side is down.** `next_turn` when no entry can act must not loop forever or throw. It returns "No one can act" and leaves the state as it is. Test lives in Task 5.
- **Rewind across `hero_fell`.** After rewinding to just before the third failed save and resolving it again, exactly one `hero_fell` must exist, and its outcome comes from the setting at the moment of the new append. Test lives in Task 3.
- **Healing a dead hero.** `hp_delta: +5` on a `dead` hero must leave them dead at 0 HP unless `revive: true` is given. Test lives in Task 2.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/rules.ts` (modify) | `Character` gains `resources`, `status`, `deathSaves`; `buildCharacter` uses `defaultResources` |
| `src/resources.ts` (create) | `Resource` type, class default table, `defaultResources`, `withDefaults`, `useResource`, `restCharacter` |
| `src/life.ts` (create) | Pure 0-HP/death-save transitions on a `Character` |
| `src/roster.ts` (create) | `Presence` type, patch application, `healthWord`, `publicPresence`, id generation, lookup |
| `src/combat.ts` (create) | Combat types, ordering, `canAct`, turn advance, `planStartCombat`, `planNextTurn` |
| `src/state.ts` (modify) | New event types and reducer cases; `playerView` strips secrets |
| `src/store.ts` (modify) | `fallenHeroes` setting; append `hero_fell` after appends; `isPlayerEvent` |
| `src/mcp.ts` (modify) | Extended `update_character`, `request_roll`, `set_scene`, `get_game_state`, `describeEvent`; calls `registerSceneTools` |
| `src/mcp-scene.ts` (create) | New tools: resources, rest, roster, combat |
| `src/server.ts` (modify) | `/api/config` + `POST /api/fallen-heroes` + SSE push |
| `src/dm-guide.ts` (modify) | DM instructions for the new tools |
| `public/app.js`, `public/i18n.js`, `public/style.css` (modify) | Strip, cards, pips, dying, combat badge, setting select |
| `test/helpers.ts` (create) | `newStore`, `mira`, `mcpClient` for tool tests |
| `test/resources.test.ts`, `test/life.test.ts`, `test/roster.test.ts`, `test/combat.test.ts` (create) | Per-module tests |

---

### Task 1: Resources, character defaults and rests

**Files:**
- Create: `src/resources.ts`, `src/mcp-scene.ts`, `test/helpers.ts`, `test/resources.test.ts`
- Modify: `src/rules.ts` (Character interface ~L163, `buildCharacter` ~L198), `src/state.ts` (events, reducer, `applyPatch`, `describePatch`), `src/mcp.ts` (`update_character`, end of `createMcpServer`)

**Interfaces:**
- Produces:
  - `type Recharge = 'short' | 'long'`
  - `interface Resource { id: string; name: string; max: number; used: number; recharge: Recharge; unit?: 'hp' }`
  - `type LifeStatus = 'up' | 'dying' | 'stable' | 'out' | 'dead'` (exported from `src/rules.ts`)
  - `Character` gains `resources: Resource[]; status: LifeStatus; deathSaves: { successes: number; failures: number }`
  - `defaultResources(classId: string, abilities: Abilities): Resource[]`
  - `withDefaults(c: Character): Character`: fills missing `resources` (class defaults), `status` (`'up'`), `deathSaves` (`{0,0}`)
  - `findResource(c: Character, idOrName: string): Resource` (throws with the list of names)
  - `useResource(c: Character, resourceId: string, amount: number): Character` (throws if `used + amount > max` or `< 0`)
  - `restCharacter(c: Character, kind: Recharge): Character`
  - Events: `{ type: 'resource_used'; characterId: string; resourceId: string; amount: number }`, `{ type: 'rest'; kind: Recharge; characterIds: string[] }`
  - `CharacterPatch` gains `resourceMax?: { resourceId: string; max: number }[]`
  - `registerSceneTools(server: McpServer, store: GameStore, h: { resolve(gameId?: string): string; character(s: GameState, id: string): Character }): void` in `src/mcp-scene.ts`
  - Test helpers: `newStore(): GameStore` and `mira(): Character` (moved from `game.test.ts`), `newTable(): { store: GameStore; db: Db }`, `mcpClient(store: GameStore, db: Db): Promise<{ call(name: string, args?: object): Promise<{ text: string; isError: boolean }>; listTools(): Promise<string[]> }>`
  - `useResource` error text: `"<Name> has no <Resource> uses left"` (and `"…can't restore past max"` for a negative amount). `use_resource` result: `"<Name>: <Resource> <left>/<max> left"`.

Resource ids and names (spec §3): `hit-dice` "Hit dice (d{hitDie})" max 1 long; `second-wind` "Second Wind" 1 short; `rage` "Rage" 2 long; `spell-slots-1` "Spell slots (1st)" 2 long; `arcane-recovery` "Arcane Recovery" 1 long; `bardic-inspiration` "Bardic Inspiration" max(1, CHA mod) long; `pact-slot` "Pact slot" 1 short; `lay-on-hands` "Lay on Hands" 5 long `unit: 'hp'`. Order on the sheet: class resources first, hit dice last.

Rest rules: short refills `recharge: 'short'`. Long refills all except hit dice, which get back `max(1, floor(max / 2))` uses; it also sets HP to max and calls `life.ts`'s wake-up (Task 2 adds that; in this task long rest only restores HP and resources).

- [ ] **Step 1: Create `test/helpers.ts` and move `newStore`/`mira` there; update `test/game.test.ts` imports.** `mcpClient` uses `InMemoryTransport.createLinkedPair()` from `@modelcontextprotocol/sdk/inMemory.js` and `Client` from `@modelcontextprotocol/sdk/client/index.js`, connecting to `createMcpServer(store, db)`. `call` returns the first text content and `isError`.

- [ ] **Step 2: Write failing tests in `test/resources.test.ts`**

```ts
test('resources: class defaults', () => {
  const wiz = buildCharacter('w', { name: 'Elowen', player: '', race: 'elf', className: 'wizard', preset: 'specialist' });
  assert.deepEqual(wiz.resources.map((r) => [r.id, r.max, r.recharge]),
    [['spell-slots-1', 2, 'long'], ['arcane-recovery', 1, 'long'], ['hit-dice', 1, 'long']]);
  assert.equal(wiz.resources.at(-1)!.name, 'Hit dice (d6)');
  assert.deepEqual(mira().resources.map((r) => r.id), ['hit-dice']);
  const pal = buildCharacter('p', { name: 'P', player: '', race: 'human', className: 'paladin', preset: 'specialist' });
  assert.deepEqual(pal.resources[0], { id: 'lay-on-hands', name: 'Lay on Hands', max: 5, used: 0, recharge: 'long', unit: 'hp' });
  assert.equal(mira().status, 'up');
  assert.deepEqual(mira().deathSaves, { successes: 0, failures: 0 });
});

test('resources: use, restore, over-use, rests', () => {
  const store = newStore();
  const g = store.createGame('T');
  const fighter = buildCharacter('f', { name: 'Torvald', player: '', race: 'dwarf', className: 'fighter', preset: 'specialist' });
  store.append(g.id, { type: 'character_created', character: fighter });
  store.append(g.id, { type: 'resource_used', characterId: 'f', resourceId: 'second-wind', amount: 1 });
  store.append(g.id, { type: 'resource_used', characterId: 'f', resourceId: 'hit-dice', amount: 1 });
  store.append(g.id, { type: 'character_updated', characterId: 'f', patch: { hpDelta: -5 } });
  const c = () => store.state(g.id).characters[0];
  assert.equal(c().resources.find((r) => r.id === 'second-wind')!.used, 1);
  assert.throws(() => useResource(c(), 'second-wind', 1), /Torvald has no Second Wind uses left/);
  store.append(g.id, { type: 'rest', kind: 'short', characterIds: ['f'] });
  assert.equal(c().resources.find((r) => r.id === 'second-wind')!.used, 0);
  assert.equal(c().resources.find((r) => r.id === 'hit-dice')!.used, 1);
  assert.equal(c().hp, c().maxHp - 5);
  store.append(g.id, { type: 'rest', kind: 'long', characterIds: ['f'] });
  assert.equal(c().resources.find((r) => r.id === 'hit-dice')!.used, 0); // max 1 → regains max(1, 0)
  assert.equal(c().hp, c().maxHp);
});

test('resources: old character_created without new fields replays with defaults', () => {
  const store = newStore();
  const g = store.createGame('T');
  const { resources, status, deathSaves, ...old } = mira();
  store.append(g.id, { type: 'character_created', character: old as any });
  const c = store.state(g.id).characters[0];
  assert.deepEqual(c.resources.map((r) => r.id), ['hit-dice']);
  assert.equal(c.status, 'up');
});

test('mcp: use_resource and rest', async () => {
  const { store, db } = newTable();
  const g = store.createGame('T');
  store.append(g.id, { type: 'character_created', character: mira() });
  const mcp = await mcpClient(store, db);
  assert.equal((await mcp.call('use_resource', { character_id: 'Mira', resource: 'hit dice (d8)' })).text, 'Mira: Hit dice (d8) 0/1 left');
  assert.equal((await mcp.call('use_resource', { character_id: 'Mira', resource: 'hit-dice' })).isError, true);
  await mcp.call('rest', { kind: 'long' });
  assert.equal(store.state(g.id).characters[0].resources[0].used, 0);
});
```

- [ ] **Step 3: Run `npm test`**, expect FAIL (`resources` undefined, unknown event types).

- [ ] **Step 4: Implement** `src/resources.ts` (table keyed by class id), the Character fields in `src/rules.ts`, `buildCharacter` calling `defaultResources`, reducer cases `resource_used` / `rest` and `withDefaults` on `character_created` in `src/state.ts`, `resourceMax` in `applyPatch`. `describePatch` adds a `['resource', '<name> <left>/<max>']` part when a resource's `used` changes, so the log shows it. `rest` logs `sys('rest', { kind, names })`. Add `resource_max` (array of `{ resource, max }`) to `update_character`. Create `src/mcp-scene.ts` with `use_resource(character_id, resource, amount = 1, game_id)` (validates via `useResource` before appending, result `"<Name>: <Resource> <left>/<max> left"`) and `rest(kind, character_ids?, game_id)`. Call `registerSceneTools(server, store, { resolve, character })` at the end of `createMcpServer`.

- [ ] **Step 5: Run `npm test && npm run typecheck`**, expect PASS.

- [ ] **Step 6: Commit** `git commit -m "Resources: class counters for limited-use abilities, short and long rests"`

---

### Task 2: Life status and death saves in the reducer

**Files:**
- Create: `src/life.ts`, `test/life.test.ts`
- Modify: `src/state.ts` (`RollRequest`, `applyPatch` → delegates HP to `life.ts`, `roll_resolved` case, `rest` long), `src/mcp.ts` (`update_character` `critical`/`revive`, `request_roll` death save, `describeEvent`, `update_character` result text)

**Interfaces:**
- Consumes: `Character`, `LifeStatus` from Task 1
- Produces:
  - `RollRequest.purpose?: 'initiative' | 'death_save'`
  - `CharacterPatch` gains `critical?: boolean; revive?: boolean`
  - `applyHpChange(before: Character, after: Character, p: CharacterPatch): Character`: given the sheet with the raw HP already applied, returns it with `status`/`deathSaves`/"Unconscious" adjusted
  - `applyDeathSave(c: Character, face: number): Character`
  - `wakeUp(c: Character, hp: number): Character`: status `up`, saves cleared, Unconscious removed, `hp = max(c.hp, hp)`; no-op for `dead`
  - `isDown(c: Character): boolean`: status in dying/stable/out/dead
  - `const UNCONSCIOUS = 'Unconscious'`

Transitions (spec §4):
- `up` and HP goes from > 0 to 0 → `dying`, saves 0/0, add Unconscious.
- `dying`/`stable` and `hpDelta < 0` → failures += `critical ? 2 : 1` (capped at 3), `stable` → `dying`, HP stays 0.
- `dying`/`stable`/`out` and HP ends > 0 → `wakeUp`.
- `dead`: HP is forced back to 0 unless `revive`, in which case `wakeUp(c, max(1, newHp))`.
- `applyDeathSave`: only when `status === 'dying'`. Nat 20 → `wakeUp(c, 1)`. Nat 1 → +2 failures. ≥ 10 +1 success, else +1 failure. Successes reaching 3 → `stable`, saves kept. Failures capped at 3; status stays `dying` (Task 3's `hero_fell` decides).
- Long rest: `wakeUp` (unless dead), then HP to max.

- [ ] **Step 1: Write failing tests in `test/life.test.ts`**, one `test()` per branch, built on a store with `mira()` (maxHp 10):
  - drop to 0 → `status 'dying'`, `conditions` includes `'Unconscious'`
  - death save faces `[12]`, `[3]` → `{ successes: 1, failures: 1 }`; `[1]` → failures 3 (from 1)
  - three successes `[10]`,`[15]`,`[19]` → `'stable'`; then `hpDelta: -2` → `'dying'`, failures 1
  - `[20]` → `status 'up'`, `hp 1`, no Unconscious
  - `hpDelta: -3, critical: true` while dying → failures 2
  - `hpDelta: +4` while dying → `'up'`, hp 4, saves `{0,0}`
  - `applyHpChange` on a sheet with `status: 'dead'` (built by hand) and `{ hpDelta: 5 }` → still `dead`, hp 0; with `{ hpDelta: 5, revive: true }` → `up`, hp 5 (Task 3 repeats this through events)
  - `roll_requested` with `purpose: 'death_save'` and a non-dying hero resolved → sheet unchanged
  - long rest on a `stable` hero → `up`, hp max

  Death-save rolls go through events: `roll_requested { rollId, characterId: 'mira', label: 'Death save', dice: '1d20', modifier: 0, advantage: 'none', hideDc: true, purpose: 'death_save' }` then `roll_resolved { rollId, faces: [n], total: n }`.

- [ ] **Step 2: Run `npm test`**, expect FAIL.

- [ ] **Step 3: Implement** `src/life.ts` and wire it into `applyPatch` / the `roll_resolved` case / long rest. `describePatch` adds `['status', status]` when status changes. In `src/mcp.ts`:
  - `update_character` gets `critical` and `revive` booleans. The result text replaces the old "At 0 HP: unconscious, start death saves." with the new status, e.g. `"Mira is dying (saves 0, fails 0). Death saves are asked automatically on her turn in combat; outside combat use request_roll with check \"death save\"."`
  - `request_roll` with `check` matching `/^death sav/i` (or the Finnish label) sets `dice: '1d20'`, `modifier: 0`, `dc: undefined`, `purpose: 'death_save'`, label `"Death save"`. It errors if the hero isn't `dying`.
  - `describeEvent` for a resolved death save: `"[seq] DEATH SAVE Mira: 14 → success (saves 2, fails 1)"`, plus `"… Mira is stable."` / `"… back up with 1 HP!"`.

- [ ] **Step 4: Run `npm test && npm run typecheck`**, expect PASS.

- [ ] **Step 5: Commit** `git commit -m "Death saves: dying, stable and recovery run by the engine"`

---

### Task 3: "When a hero falls" setting and `hero_fell`

**Files:**
- Modify: `src/store.ts`, `src/state.ts` (event + reducer), `src/server.ts` (config, route, SSE), `src/mcp.ts` (`get_game_state`, `wait_for_players` header, `describeEvent`)
- Test: `test/life.test.ts`

**Interfaces:**
- Consumes: `applyDeathSave`, `wakeUp` from Task 2
- Produces:
  - `export const FALLEN_MODES = ['knockout', 'death'] as const; export type FallenMode`
  - `export const FALLEN_GUIDE: Record<FallenMode, string>`: DM-facing text. `knockout` contains the notice text from spec §5. `death` says a hero who fails three saves dies and to narrate it with care.
  - `GameStore.fallenHeroes(): FallenMode` (setting key `fallen_heroes`, default `'knockout'`), `GameStore.setFallenHeroes(mode: FallenMode): void` (throws on bad value; `notifyDm` on the active game with `FALLEN_GUIDE[mode]`; emits `'fallenHeroes'`)
  - Event `{ type: 'hero_fell'; characterId: string; outcome: 'dead' | 'knocked_out' }`. Reducer: status `dead` or `out`, sys log `sys('fell', { name, outcome })`.
  - `isPlayerEvent` includes `hero_fell`
  - `GET /api/config` includes `fallenHeroes`. `POST /api/fallen-heroes { fallenHeroes }`. SSE `{ type: 'fallenHeroes', fallenHeroes }`.

`GameStore.append` behaviour: after applying an event, if the resulting state has a character with `status === 'dying' && deathSaves.failures >= 3`, append `hero_fell` for it with `outcome = fallenHeroes() === 'death' ? 'dead' : 'knocked_out'`. Guard against recursion by only checking when the appended event isn't itself `hero_fell`.

`describeEvent` for `hero_fell`: knocked out → `"[seq] Mira has FALLEN — knocked out, not killed. " + FALLEN_GUIDE.knockout`. Dead → `"[seq] Mira has DIED. " + FALLEN_GUIDE.death`.

- [ ] **Step 1: Write failing tests** (append to `test/life.test.ts`):
  - With default setting, three failed saves → state has `status 'out'`, last live event is `hero_fell` with `outcome 'knocked_out'`, and `store.unseenPlayerEvents()` includes it.
  - `setFallenHeroes('death')`, same sequence → `'dead'`. Then `setFallenHeroes('knockout')`, `store.rewind` to a seq after `hero_fell` (no-op on it), re-replay with `cache` cleared (`store.stateAt(g.id, latestSeq)`) → still `'dead'` (recorded outcome wins).
  - **Review Focus:** with mode `death`, rewind to just before the third failure's `roll_resolved`, set mode `knockout`, resolve the re-opened roll again with face `[2]` → exactly one live `hero_fell`, outcome `'knocked_out'`.
  - `setFallenHeroes('x')` throws. `fallenHeroes()` defaults to `'knockout'`. Changing it puts a notice in `pendingNotices`.
  - Healing an `out` hero (`hpDelta: 3`) → `up`, hp 3.
  - **Review Focus:** with mode `death`, a hero who fell → `update_character` `hp_delta: 5` leaves them `dead` at hp 0; with `revive: true` → `up`, hp 5.

- [ ] **Step 2: Run `npm test`**, expect FAIL.

- [ ] **Step 3: Implement** the store setting, the follow-up append, the reducer case, routes and SSE wiring (follow `verbosity` line for line), and add `fallenHeroes: FALLEN_GUIDE[...]` to `get_game_state` plus `When a hero falls: ${mode}` to the `wait_for_players` header.

- [ ] **Step 4: Run `npm test && npm run typecheck`**, expect PASS.

- [ ] **Step 5: Commit** `git commit -m "Table setting for fallen heroes: knocked out (default) or can die"`

---

### Task 4: Scene roster

**Files:**
- Create: `src/roster.ts`, `test/roster.test.ts`
- Modify: `src/state.ts` (`GameState.present`, `emptyState`, events, `scene_set`, `playerView`), `src/mcp.ts` (`set_scene` `present`, `get_game_state`), `src/mcp-scene.ts` (roster tools)

**Interfaces:**
- Produces:
  - `type Side = 'enemy' | 'neutral' | 'ally'`
  - `interface Presence`, exactly as in spec §1
  - `interface PresencePatch { hpDelta?: number; hp?: number; maxHp?: number; ac?: number; side?: Side; description?: string; addConditions?: string[]; removeConditions?: string[]; notes?: string; defeated?: boolean }`
  - `type HealthWord = 'unhurt' | 'hurt' | 'bloodied' | 'nearDeath' | 'defeated'`
  - `healthWord(p: Presence): HealthWord | undefined`
  - `applyPresencePatch(p: Presence, patch: PresencePatch): Presence`: HP clamped to `[0, maxHp]`, HP 0 → `defeated: true`, HP > 0 after healing → `defeated: false` unless the patch sets `defeated`
  - `publicPresence(p: Presence): { id; name; groupId; side; description; conditions; defeated; health?: HealthWord }`
  - `newPresences(existing: Presence[], spec: { name: string; side: Side; description?: string; hp?: number; ac?: number; initiativeBonus?: number; notes?: string }, count: number): Presence[]`: ids are `slug(name)` when count is 1 and the slug is free, else `slug-1…slug-n` skipping taken ids. `groupId` = the first new id. `slug` = lowercase, runs of non-`[a-z0-9]` → `-`, trimmed.
  - `findPresence(present: Presence[], idOrName: string): Presence`: case-insensitive id first; else case-insensitive name among non-defeated; 0 matches → error listing ids; > 1 matches → error `"Several creatures are called Goblin: goblin-1, goblin-2. Use the id."`
  - `GameState.present: Presence[]`
  - Events: `{ type: 'presence_added'; presences: Presence[] }`, `{ type: 'presence_updated'; presenceId: string; patch: PresencePatch; reason?: string }`, `{ type: 'presence_removed'; presenceIds: string[] }`. `scene_set` gains `present?: Presence[]` (replaces roster when defined).
  - Tools in `src/mcp-scene.ts`: `add_to_scene(name, side, description?, hp?, ac?, initiative_bonus?, notes?, count = 1, initiative?, game_id)`, `update_presence(presence_id, hp_delta?, hp?, max_hp?, ac?, side?, description?, add_conditions?, remove_conditions?, notes?, defeated?, reason?, game_id)`, `remove_from_scene(presence_ids: string[] | 'all', game_id)`. (`initiative` on `add_to_scene` is used by Task 5.)
  - `set_scene` gains `present?: Array<{ name, side, description?, hp?, ac?, initiative_bonus?, notes?, count? }>`. When omitted and the roster is non-empty, the result adds: `" Still present: Goblin ×2, Captive priest. If the place changed, pass present or use remove_from_scene."`

Log lines (sys, player-safe, no numbers): `arrived { names }`, `left { names }`, `presenceUpdated { name, health?, condOn?, condOff?, sideChange? }` and `defeated { name }`.

- [ ] **Step 1: Write failing tests in `test/roster.test.ts`**:
  - `healthWord` at hp 10/10, 6/10, 5/10, 3/10, 2/10, 0/10 → `unhurt, hurt, bloodied, bloodied, nearDeath, defeated` (5/10 is exactly 50%, so not "> 50%" → bloodied; 3/10 = 30% > 25% → bloodied; 2/10 → nearDeath). No hp → `undefined`; no hp but `defeated` → `'defeated'`.
  - `newPresences([], {name: 'Goblin', side: 'enemy', hp: 7}, 2)` ids `['goblin-1', 'goblin-2']`, same `groupId`, names both `'Goblin'`. Adding one more Goblin → `'goblin'` (slug free). Adding 1 more after that → `'goblin-3'`.
  - **Review Focus:** `findPresence(present, 'goblin')` with two live goblins → throws `/goblin-1, goblin-2/`; `'GOBLIN-2'` → goblin-2; `'Goblin'` with goblin-1 defeated → goblin-2; `'orc'` → throws listing all ids.
  - `update_presence` HP to 0 → `defeated: true`, sys log `defeated`.
  - `playerView(state).present[0]` has exactly keys `id, name, groupId, side, description, conditions, defeated, health`. Also `JSON.stringify(playerView(state))` does not contain `"hp"`, `"maxHp"`, `"ac"`, `"initiativeBonus"`, `"notes"` or the creature's secret note text.
  - `scene_set` with `present: []` empties the roster. `scene_set` without `present` keeps it.
  - MCP: `add_to_scene` with `count: 2` then `update_presence` `presence_id: 'goblin-1', hp_delta: -7` → `defeated`; `remove_from_scene` `'all'` → empty.

- [ ] **Step 2: Run `npm test`**, expect FAIL.

- [ ] **Step 3: Implement** `src/roster.ts`, the state/reducer/`playerView` changes, and the tools. `get_game_state` includes `present` in full (DM view).

- [ ] **Step 4: Run `npm test && npm run typecheck`**, expect PASS.

- [ ] **Step 5: Commit** `git commit -m "Scene roster: enemies, neutrals and allies present in the scene"`

---

### Task 5: Combat tracker

**Files:**
- Create: `src/combat.ts`, `test/combat.test.ts`
- Modify: `src/state.ts` (`GameState.combat`, events, `roll_resolved`/`roll_cancelled` for initiative, `playerView`), `src/mcp-scene.ts` (combat tools, `add_to_scene` with `initiative`), `src/mcp.ts` (`describeEvent`, `get_game_state`)

**Interfaces:**
- Consumes: `Presence`, `findPresence` (Task 4); `LifeStatus`, `wakeUp` (Tasks 1–2)
- Produces:
  - `type CombatRef = { kind: 'hero'; id: string } | { kind: 'group'; groupId: string }`
  - `interface CombatEntry { ref: CombatRef; initiative: number | null; tiebreak: number }` (`tiebreak` = hero DEX score, or group initiative bonus)
  - `interface Combat { round: number; turn: number; order: CombatEntry[] }`. `round === 0` means gathering.
  - `GameState.combat: Combat | null`
  - `sortOrder(order: CombatEntry[]): CombatEntry[]`: initiative desc, then tiebreak desc, then heroes before groups, then original position
  - `canAct(s: GameState, e: CombatEntry): boolean`: hero → status `up` or `dying`; group → any member present and not defeated
  - `currentActor(s: GameState): CombatEntry | undefined`
  - `planStartCombat(s: GameState, participants: { heroes: string[]; groupIds: string[] }, roll: () => number): GameEvent[]`: one `combat_started` event (with creature initiatives already rolled via `roll()` = d20 face) and one `roll_requested` per hero (`purpose: 'initiative'`, dice `1d20`, modifier = DEX mod, label "Initiative", `hideDc: true`)
  - `planNextTurn(s: GameState): GameEvent[]`: `[turn_advanced]`, plus a death-save `roll_requested` if the new actor is a dying hero. `[]` when no entry can act.
  - Events: `{ type: 'combat_started'; order: CombatEntry[] }` (heroes with `initiative: null`), `{ type: 'turn_advanced' }`, `{ type: 'combatant_added'; entry: CombatEntry }`, `{ type: 'combat_ended' }`
  - Tools: `start_combat(hero_ids?, presence_ids?, game_id)` (default: all heroes that are up or dying, all groups with a live enemy/ally member; presence ids are mapped to their groups), `next_turn(game_id)`, `add_to_combat(presence_id | character_id, initiative, game_id)`, `end_combat(game_id)`. `add_to_scene` with `initiative` while combat is on also appends `combatant_added` for the new group.

Reducer rules:
- `combat_started` → `combat = { round: 0, turn: 0, order }`; sys `combatStarted`. If no hero entries are null (all-creature fight), start immediately: sort, round 1.
- `roll_resolved` with `purpose: 'initiative'` → set that hero's initiative to `total`. When none are null → `order = sortOrder(order)`, `round = 1`, `turn` = first index that `canAct`; sys `combatOrder { names }` (names only).
- `roll_cancelled` of an initiative roll → remove that hero's entry, then the same "all in?" check (**Review Focus**).
- `turn_advanced` → move `turn` forward to the next index where `canAct`, wrapping increments `round`. If none can act, unchanged.
- `combatant_added` → insert, re-sort, keep `turn` pointing at the same actor.
- `combat_ended` → `combat = null`; every hero with status `out` → `wakeUp(c, 1)`; sys `combatEnded`.

`playerView`: `combat` becomes `{ round, turn, order: order.map(e => ({ ref: e.ref, ready: e.initiative !== null })) }`. No totals, no tiebreaks.

Tool results: `start_combat` → `"Fight! Asked Mira, Torvald for initiative. Goblins rolled 14 (secret). The order is set when all rolls are in."`. `next_turn` → `"Round 2 — Mira's turn."`, `"Round 2 — Goblin (goblin-1, goblin-2)'s turn: act for them, then call next_turn."` or `"Round 2 — Mira is dying: asked for her death save."` or `"No one can act."`. `describeEvent` for the initiative roll that completes the order adds `"Initiative order: Goblin 18, Mira 15, Torvald 9. Round 1: Goblin's turn."`.

- [ ] **Step 1: Write failing tests in `test/combat.test.ts`**:
  - `sortOrder` ties: hero 15 (DEX 17) vs group 15 (bonus 2) → hero first; hero 15 DEX 12 vs group 15 bonus 2 → hero first (12 > 2); two heroes 15 DEX 14 and DEX 14 → original order.
  - Gathering: start with Mira and Torvald plus a goblin group (roll stub `() => 12`), state `round 0`; resolve Mira's initiative 18 → still `round 0`; resolve Torvald's 5 → `round 1`, order `[Mira, goblins(12+bonus), Torvald]`, `currentActor` is Mira.
  - `turn_advanced` from last entry wraps to `round 2`. Defeated goblin group (all members `defeated`) is skipped. Hero with status `out` skipped.
  - `planNextTurn` landing on a dying hero returns `[turn_advanced, roll_requested(purpose 'death_save')]`.
  - **Review Focus:** cancelling Torvald's initiative roll during gathering → combat starts with Mira and the goblins.
  - **Review Focus:** everyone `out`/defeated → `planNextTurn` returns `[]`, and `next_turn` tool text is `"No one can act."`.
  - `combatant_added` mid-round with initiative higher than the current actor → `currentActor` unchanged.
  - `combat_ended` → `combat null`, an `out` hero is `up` with hp 1.
  - `Object.keys(playerView(s).combat.order[i]).sort()` deep-equals `['ready', 'ref']` for every entry, and `Object.keys(playerView(s).combat).sort()` equals `['order', 'round', 'turn']`.
  - Rewind: rewind to before `combat_started` → `combat null`. Rewind to between gathering and order → `round 0` and the initiative roll is pending again.

- [ ] **Step 2: Run `npm test`**, expect FAIL.

- [ ] **Step 3: Implement** `src/combat.ts`, reducer cases, `playerView`, tools (`roll` = `virtualRoll(parseDice('1d20'), 'none', 0).faces[0]` in the tool, injected into `planStartCombat`).

- [ ] **Step 4: Run `npm test && npm run typecheck`**, expect PASS.

- [ ] **Step 5: Commit** `git commit -m "Combat tracker: initiative gathering, turn order, rounds"`

---

### Task 6: Page — hero cards, resources, dying, setting

**Files:**
- Modify: `public/app.js` (`renderParty` ~L524, `sheetHtml` ~L312, roll prompt rendering ~L549, topbar pickers ~L142-157, SSE handler ~L65, `cfg`), `public/i18n.js`, `public/style.css`

**Interfaces:**
- Consumes: `playerView` JSON from Tasks 1–5: `characters[].resources/status/deathSaves`, `pendingRolls[].purpose`; `/api/config.fallenHeroes`; SSE `fallenHeroes`

UI rules:
- Hero card: blue side border (`--side-hero`). Below HP, one row per resource: translated name (by id, via `t().resources[id]`, fallback stored name) + pips `●`×left `○`×used, or `left/max` when `unit === 'hp'`. Hit dice hidden at beginner.
- Status `dying` → card class `dying` (red), sub-line "Fading" (beginner) / "Dying" (casual+), and two pip rows "Holding on ●●○" / "Slipping ●○○" (beginner) or "Saves" / "Fails". `stable` → "Stable" / "Resting, stable". `out` → "Out cold" / "Knocked out", muted. `dead` → muted, "✝ Fallen".
- Sheet modal: resources with recharge text (`t().recharge.short` / `.long`, beginner wording "Back after a short break" / "Back after a night's sleep").
- Death-save roll prompt (`purpose === 'death_save'`): beginner text `t().deathSavePrompt(name)` = "Mira is fading. Roll a d20: 10 or more and she holds on." Use the character's name. Pronoun-free FI/EN wording is preferred (avoid "she"/"he": "Mira is fading. Roll a d20: 10 or more holds on."). Casual/intermediate: "Death save" / "Death saving throw".
- Topbar select `#fallen` after `verbosityPicker()`: "When a hero falls: Knocked out / Can die". Posts to `/api/fallen-heroes`. Updates on SSE.
- New `sys` log codes from Tasks 1–5 (`rest`, `fell`, `resource` part, `status` part, `arrived`, `left`, `presenceUpdated`, `defeated`, `combatStarted`, `combatOrder`, `combatEnded`) get renderers in the existing sys-line formatter in both languages.
- Colours as CSS tokens on `:root` and in the dark-mode block: `--side-hero`, `--side-enemy`, `--side-neutral`, `--side-ally`, `--turn-ring`.

- [ ] **Step 1: Add strings to `public/i18n.js`** for `en` and `fi`: `resources` (by id), `recharge`, `life` (per status × level), `deathSaves` labels per level, `deathSavePrompt`, `fallen` picker labels, `health` words, `combat` (`fight`, `round`, `turnOf`), and every new sys code. FI follows the tone of existing strings.

- [ ] **Step 2: Implement the card, sheet, prompt, picker and sys-line changes in `public/app.js` and the CSS.**

- [ ] **Step 3: Verify in the browser.** Use the `run` skill: `npm start`, open a game with a wizard and a rogue, and drive state with `curl` against the MCP tools or by appending events in a scratch script using `GameStore` on a copy of the DB (`DB_PATH=/tmp/...`). Check: pips match spend/rest; a dying card shows both pip rows and a death-save prompt; picker switches and survives reload; EN/FI and all three complexity levels; dark mode.

- [ ] **Step 4: Run `npm test && npm run typecheck`**, expect PASS.

- [ ] **Step 5: Commit** `git commit -m "Page: resource pips, dying hero cards and the fallen-heroes setting"`

---

### Task 7: Page — scene roster and combat strip

**Files:**
- Modify: `public/app.js` (`renderParty`, new `showPresence(card)` modal, `renderTopbar`), `public/i18n.js`, `public/style.css`

**Interfaces:**
- Consumes: `present[]` (public shape from Task 4) and `combat` (public shape from Task 5)

Strip rules (spec §1–2, mockup option A):
- Out of combat: heroes, then creatures in roster order.
- Creature cards: build display cards by grouping `present` on `(groupId, health)`. Label `name` + ` ×n` when n > 1. Border/background by side. Health word under the name, and a bar with width by band: unhurt 100, hurt 75, bloodied 45, nearDeath 15, defeated 0. No word or bar when `health` is undefined. Defeated: greyed and struck through.
- Click → `showPresence` modal: name, health word, description, conditions.
- In combat (`combat !== null`): cards ordered by `combat.order`. Each hero/group card gets a turn number (1-based index). All split cards of one group share the number. The active entry (`combat.turn`, when `round > 0`) gets the gold ring. Creatures and heroes not in the order go last without a number. Topbar shows "⚔ Round N", or "⚔ Fight!" while `round === 0`. Entries with `ready: false` show "…" instead of a number.
- Timeline scrubbing needs nothing extra: it already renders `shown`.

- [ ] **Step 1: Implement**, adding any missing strings in both languages.

- [ ] **Step 2: Verify in the browser** as in Task 6: add 2 goblins and a neutral, damage one goblin (the card splits into two with the same turn number), start combat, resolve initiatives, advance turns past a wrap (Round 2), defeat both goblins (skipped, struck through), end combat (badge and numbers gone). Check the `/api/games/:id/state` JSON in devtools contains no creature HP/AC/initiative. Check phone width (no horizontal page scroll beyond the strip's own scroll).

- [ ] **Step 3: Run `npm test && npm run typecheck`**, expect PASS.

- [ ] **Step 4: Commit** `git commit -m "Page: everyone in the scene in one strip, turn order during fights"`

---

### Task 8: DM guide

**Files:**
- Modify: `src/dm-guide.ts`, `README.md` (one paragraph under "Playing")
- Test: `test/game.test.ts`

- [ ] **Step 1: Write a failing test** asserting `DM_GUIDE` mentions each new tool: `for (const tool of ['add_to_scene', 'update_presence', 'remove_from_scene', 'start_combat', 'next_turn', 'end_combat', 'use_resource', 'rest']) assert.ok(DM_GUIDE.includes(tool), tool)`. Also assert every one of those names is actually registered: list them via `mcpClient` `listTools` (add `listTools()` to the helper).

- [ ] **Step 2: Run `npm test`**, expect FAIL.

- [ ] **Step 3: Rewrite the "Rules" combat bullets and "Memory" bullets** per spec §6. Replace "keep the order in a DM note" and "monster HP" in notes with the roster and combat tools. Add a short "Resources and rests" section covering hit-dice spending on a short rest (request the hit die roll with CON modifier, then `use_resource` hit-dice and `update_character` heal). Add a "Falling" section on reacting to `hero_fell` per the setting, with the beginner rule: narrate the tension, never the mechanics. README: one paragraph on the strip, turn order, pips and the "When a hero falls" setting.

- [ ] **Step 4: Run `npm test && npm run typecheck`**, expect PASS.

- [ ] **Step 5: Commit** `git commit -m "DM guide: scene roster, combat, resources and falling"`
