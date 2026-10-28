import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { entryName } from './combat.ts';
import type { Db } from './db.ts';
import { parseDice, physicalDice, virtualRoll } from './dice.ts';
import { DM_GUIDE } from './dm-guide.ts';
import { fightRefs, orderText, registerSceneTools, roundText } from './mcp-scene.ts';
import { findResource } from './resources.ts';
import { newPresences, presenceSpec, stillPresent, toSpec, type Presence } from './roster.ts';
import { checkModifier, type Character } from './rules.ts';
import { attackRoll, damageRoll, sheetOf } from './sheet.ts';
import { findSpell, SPELLS, type Spell } from './spells.ts';
import { getSketchStyle, sanitizeSketch, setSketchStyle, SKETCH_HEIGHT, SKETCH_WIDTH } from './sketch.ts';
import type { GameState, StoredEvent } from './state.ts';
import { COMPLEXITY_GUIDE, FALLEN_GUIDE, LANGUAGE_NAMES, VERBOSITY_GUIDE, type GameStore } from './store.ts';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);

const gameIdArg = z.string().optional().describe('Game id. Defaults to the game currently open on the table.');

function describeEvent(s: GameState, { seq, event: e }: StoredEvent): string {
  const who = (id?: string) => s.characters.find((c) => c.id === id)?.name ?? 'Someone';
  switch (e.type) {
    case 'message':
      return `[${seq}] ${who(e.characterId)} (${e.kind}): ${e.text}`;
    case 'roll_resolved': {
      const r = s.rolls.find((x) => x.rollId === e.rollId);
      if (!r) return `[${seq}] Roll ${e.rollId} resolved: ${e.total}`;
      if (r.purpose === 'death_save') {
        const c = s.characters.find((x) => x.id === r.characterId);
        const face = e.faces[0];
        const saves = c ? ` (saves ${c.deathSaves.successes}, fails ${c.deathSaves.failures})` : '';
        const end = c?.status === 'stable' ? ` ${c.name} is stable.` : face === 20 ? ` ${who(r.characterId)} is back up with 1 HP!` : '';
        return `[${seq}] DEATH SAVE ${who(r.characterId)}: ${face} → ${face === 20 ? 'natural 20' : face === 1 ? 'natural 1, two failures' : face >= 10 ? 'success' : 'failure'}${saves}${end}`;
      }
      const vs = r.dc !== undefined ? ` vs DC ${r.dc} → ${e.success ? 'SUCCESS' : 'FAILURE'}` : '';
      const lastInitiative = r.purpose === 'initiative' && s.combat && s.combat.round > 0
        && s.rolls.findLast((x) => x.purpose === 'initiative') === r;
      const order = lastInitiative ? ` Initiative order: ${orderText(s)}. ${roundText(s)}` : '';
      return `[${seq}] ROLL ${who(r.characterId)} — ${r.label}: dice ${e.faces.join(', ')}${r.advantage !== 'none' ? ` (${r.advantage})` : ''} ${sign(r.modifier)} = ${e.total}${vs}${order}`;
    }
    case 'character_created': {
      const c = e.character;
      return `[${seq}] NEW CHARACTER ${c.name} (id ${c.id}), played by ${c.player || '?'}: level ${c.level} ${c.race} ${c.className}, HP ${c.maxHp}, AC ${c.ac}`;
    }
    case 'hero_fell':
      return e.outcome === 'dead'
        ? `[${seq}] ${who(e.characterId)} has DIED. ${FALLEN_GUIDE.death}`
        : `[${seq}] ${who(e.characterId)} has FALLEN — knocked out, not killed. ${FALLEN_GUIDE.knockout}`;
    case 'game_started':
      return `[${seq}] The players pressed "Begin the adventure". Open the story: set the scene, narrate an opening and sketch it.`;
    default:
      return `[${seq}] ${e.type}`;
  }
}

type SpellArg = string | {
  name: string; level: 0 | 1; casting_time: Spell['castingTime']; range: string; summary: string; concentration?: boolean;
  attack?: Spell['attack']; save?: Spell['save']; dice?: string; add_mod?: boolean; damage_type?: string; heal?: boolean;
};

/** A built-in spell by name, or the DM's own. */
function toSpell(a: SpellArg): Spell {
  if (typeof a === 'string') {
    const known = findSpell(a);
    if (!known) throw new Error(`No built-in spell "${a}". Describe it as an object instead: name, level, range, summary, and attack/save/dice if it has them.`);
    return { ...known };
  }
  if (a.dice) parseDice(a.dice);
  const id = a.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const opt = { concentration: a.concentration, attack: a.attack, save: a.save, dice: a.dice, addMod: a.add_mod, damageType: a.damage_type, heal: a.heal };
  return { id, name: a.name.trim(), level: a.level, castingTime: a.casting_time, range: a.range, summary: a.summary,
    ...Object.fromEntries(Object.entries(opt).filter(([, v]) => v !== undefined)) };
}

function lifeNote(c: Character): string {
  const saves = `saves ${c.deathSaves.successes}, fails ${c.deathSaves.failures}`;
  if (c.status === 'dying') return `. ${c.name} is dying (${saves}). Death saves are asked automatically on ${c.name}'s turn in combat; outside combat use request_roll with check "death save".`;
  if (c.status === 'stable') return `. ${c.name} is stable at 0 HP (unconscious).`;
  if (c.status === 'out') return `. ${c.name} is knocked out at 0 HP: wakes with 1 HP when the fight ends, or sooner if healed.`;
  if (c.status === 'dead') return `. ${c.name} is dead.`;
  return '';
}

/** Nudges the DM to keep the canvas in step with the story. */
function sketchReminder(s: GameState): string {
  const lastSketch = s.sketches.at(-1)?.seq ?? 0;
  if (!s.scene || s.scene.seq <= lastSketch) return '';
  return ' The scene changed but the canvas still shows the old picture: draw_sketch the new place now.';
}

function historyLine({ seq, at, event: e }: StoredEvent): string {
  const short = (t: string) => (t.length > 90 ? `${t.slice(0, 87)}…` : t);
  const detail =
    e.type === 'message' ? `${e.from}/${e.kind}: ${short(e.text)}` :
    e.type === 'sketch' ? `sketch: ${e.caption}` :
    e.type === 'scene_set' ? `scene: ${e.title}` :
    e.type === 'character_updated' ? `${e.characterId} ${JSON.stringify(e.patch)}` :
    e.type === 'roll_requested' ? `roll requested: ${e.roll.label}` :
    e.type === 'roll_resolved' ? `roll resolved: ${e.total}` :
    e.type === 'dm_note' ? `note: ${short(e.text)}` : '';
  return `${seq}\t${at.slice(0, 19)}\t${e.type}\t${detail}`;
}

export function createMcpServer(store: GameStore, db: Db): McpServer {
  const server = new McpServer(
    { name: 'dnd-table', version: '0.1.0' },
    { instructions: 'D&D table server. You are the DM. Use the `dm` prompt or read dnd://dm-guide for how to run a session, then loop on wait_for_players.' },
  );

  const resolve = (gameId?: string) => {
    const id = gameId ?? store.activeGameId();
    if (!id) throw new Error('No game exists yet. Ask the players to create one in the web page, then call wait_for_players.');
    store.requireGame(id);
    store.touchDm(id);
    return id;
  };

  const adventureChanged = (from: string, to: string) =>
    `ADVENTURE CHANGED: the table switched from "${store.state(from).title}" to "${store.state(to).title}" (game ${to}). ` +
    'Leave the previous adventure behind (its party, scene, notes and plot). Call get_game_state now, then continue this adventure from where it left off.';

  const character = (s: GameState, id: string) => {
    const c = s.characters.find((x) => x.id === id || x.name.toLowerCase() === id.toLowerCase());
    if (!c) throw new Error(`No character "${id}". Characters: ${s.characters.map((x) => `${x.name} (${x.id})`).join(', ') || 'none'}`);
    return c;
  };

  // ---- Guide & style -------------------------------------------------------

  server.registerResource('dm-guide', 'dnd://dm-guide', { title: 'How to DM this table', mimeType: 'text/markdown' },
    (uri) => ({ contents: [{ uri: uri.href, text: DM_GUIDE }] }));

  server.registerResource('sketch-style', 'sketch://style', { title: 'Sketch style guide', mimeType: 'text/markdown' },
    (uri) => ({ contents: [{ uri: uri.href, text: getSketchStyle(db) }] }));

  server.registerPrompt('dm', { title: 'Be the Dungeon Master', description: 'Start running the game at the table.' },
    () => ({ messages: [{ role: 'user', content: { type: 'text', text: `${DM_GUIDE}\n\nBegin now: call get_game_state, then follow the loop.` } }] }));

  server.registerTool('get_dm_guide', { description: 'How to run this table as DM. Read it at the start of a session.', annotations: { readOnlyHint: true } },
    () => text(DM_GUIDE));

  server.registerTool('get_sketch_style', {
    description: 'The shared pencil-sketch style guide. Read before drawing so every session draws in the same hand.',
    annotations: { readOnlyHint: true },
  }, () => text(getSketchStyle(db)));

  server.registerTool('set_sketch_style', {
    description: 'Replace the shared sketch style guide (markdown). Persists for all future sessions; only change it when the players ask for a different look.',
    inputSchema: { style: z.string().min(50) },
  }, ({ style }) => { setSketchStyle(db, style); return text('Sketch style updated.'); });

  // ---- Games ---------------------------------------------------------------

  server.registerTool('list_games', { description: 'All saved games, most recently played first.', annotations: { readOnlyHint: true } },
    () => json({ active: store.activeGameId(), games: store.listGames() }));

  server.registerTool('create_game', {
    description: 'Create a new game and open it on the table. Usually the players do this from the web page.',
    inputSchema: { title: z.string().min(1) },
  }, ({ title }) => json(store.createGame(title)));

  server.registerTool('select_game', {
    description: 'Open a saved game on the table.',
    inputSchema: { game_id: z.string() },
  }, ({ game_id }) => { store.setActiveGame(game_id); return text(`Game ${game_id} is now on the table.`); });

  server.registerTool('get_game_state', {
    description: 'Full DM view of the game: party character sheets, scene, pending rolls, your private notes and the recent story log.',
    inputSchema: { game_id: gameIdArg, log_limit: z.number().int().min(1).max(500).default(40) },
    annotations: { readOnlyHint: true },
  }, ({ game_id, log_limit }) => {
    const id = resolve(game_id);
    if (!game_id) store.setDmGame(id);
    const s = store.state(id);
    return json({
      language: `${LANGUAGE_NAMES[store.language()]}: write everything the players see in this language.`,
      complexity: COMPLEXITY_GUIDE[store.complexity()],
      verbosity: VERBOSITY_GUIDE[store.verbosity()],
      fallenHeroes: FALLEN_GUIDE[store.fallenHeroes()],
      id: s.id, title: s.title, started: s.started, seq: s.seq, scene: s.scene,
      characters: s.characters.map((c) => {
        const { features: _f, inventory: _i, ...numbers } = sheetOf(c);
        return { ...c, sheet: numbers };
      }),
      present: s.present,
      combat: s.combat && { ...s.combat, order: s.combat.order.map((e) => ({ name: entryName(s, e), ...e })) },
      pendingRolls: s.pendingRolls,
      dmNotes: s.dmNotes,
      sketchCount: s.sketches.length,
      lastSketchCaption: s.sketches.at(-1)?.caption,
      recentLog: s.log.slice(-log_limit).map((l) => ({ seq: l.seq, from: l.from, kind: l.kind, character: s.characters.find((c) => c.id === l.characterId)?.name, text: l.text })),
      unseenPlayerEvents: store.unseenPlayerEvents(id).length,
    });
  });

  server.registerTool('wait_for_players', {
    description: 'Block until the players do something (message, question, roll result, new character), then return it. On timeout, call again. This is the heartbeat of the session.',
    inputSchema: {
      game_id: gameIdArg,
      timeout_seconds: z.number().int().min(5).max(3600).default(50)
        .describe('How long to wait. Keep below your MCP tool timeout (raise it with MCP_TOOL_TIMEOUT).'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ game_id, timeout_seconds }, extra) => {
    const id = game_id ?? store.activeGameId();
    if (!id) {
      await new Promise((r) => setTimeout(r, Math.min(timeout_seconds, 30) * 1000));
      return text('No game yet. The players have not created one. Call wait_for_players again.');
    }
    // Without a game_id the DM follows whatever adventure is open on the table.
    if (!game_id) {
      const last = store.dmGame();
      store.setDmGame(id);
      if (last && last !== id && store.exists(last)) return text(adventureChanged(last, id));
    }
    const { events, notices } = await store.waitForPlayers(id, timeout_seconds * 1000, 2500, extra.signal);
    const now = store.activeGameId();
    const switched = !game_id && now && now !== id ? adventureChanged(id, now) : '';
    if (switched) store.setDmGame(now!);
    if (!events.length && !notices.length) return text(switched || 'Nothing yet. The table is quiet. Call wait_for_players again.');
    const s = store.state(id);
    const header = [...notices, `(Table language: ${LANGUAGE_NAMES[store.language()]}. Complexity: ${store.complexity()}. Verbosity: ${store.verbosity()}/4. When a hero falls: ${store.fallenHeroes()}.)`].join('\n');
    const pending = s.pendingRolls.length
      ? `\n\nStill waiting on rolls: ${s.pendingRolls.map((r) => `${character(s, r.characterId).name} — ${r.label} (${r.rollId})`).join('; ')}`
      : '';
    return text(`${header}\n\n${events.map((e) => describeEvent(s, e)).join('\n')}${pending}${switched ? `\n\n${switched}` : ''}`);
  });

  // ---- Talking to the table -------------------------------------------------

  server.registerTool('narrate', {
    description: 'Say something to the table as the DM. kind "narration" for story, "answer" for replying to a player question, "ooc" for table talk.',
    inputSchema: {
      text: z.string().min(1),
      kind: z.enum(['narration', 'answer', 'ooc']).default('narration'),
      character_id: z.string().optional().describe('Who you are answering, if anyone.'),
      game_id: gameIdArg,
    },
  }, ({ text: t, kind, character_id, game_id }) => {
    const id = resolve(game_id);
    const characterId = character_id ? character(store.state(id), character_id).id : undefined;
    const ev = store.append(id, { type: 'message', from: 'dm', kind, characterId, text: t });
    return text(`Shown to the table (seq ${ev.seq}).${sketchReminder(store.state(id))}`);
  });

  server.registerTool('set_scene', {
    description: 'Set the current location shown at the top of the table, e.g. "The Drowned Lantern — taproom".',
    inputSchema: {
      title: z.string().min(1),
      description: z.string().default(''),
      present: z.array(presenceSpec).optional().describe('Who is in the new place (enemies, neutrals, allies; never the heroes). Replaces the current roster; [] empties it. Omit to leave the roster as it is.'),
      game_id: gameIdArg,
    },
  }, ({ title, description, present, game_id }) => {
    const id = resolve(game_id);
    let roster: Presence[] | undefined;
    if (present) {
      roster = [];
      // Ids of who was here, or is still in the turn order, are not reused for newcomers.
      const before = store.state(id);
      const reserved = [...before.present.flatMap((p) => [p.id, p.groupId]), ...fightRefs(before)];
      for (const spec of present) roster.push(...newPresences(roster, toSpec(spec), spec.count, reserved));
    }
    store.append(id, { type: 'scene_set', title, description, present: roster });
    const left = store.state(id).present;
    const still = present === undefined && left.length ? ` Still present: ${stillPresent(left)}. If the place changed, pass present or use remove_from_scene.` : '';
    return text(`Scene set.${still}${sketchReminder(store.state(id))}`);
  });

  server.registerTool('add_dm_note', {
    description: 'Private DM notebook (never shown to players): secrets, NPC motives, plot threads, things to remember later. Creature HP and the turn order are tracked by the scene and combat tools.',
    inputSchema: { text: z.string().min(1), game_id: gameIdArg },
  }, ({ text: t, game_id }) => {
    const id = resolve(game_id);
    const ev = store.append(id, { type: 'dm_note', text: t });
    return text(`Noted (seq ${ev.seq}).`);
  });

  // ---- Dice ----------------------------------------------------------------

  server.registerTool('request_roll', {
    description: 'Ask a player to throw physical dice. The page shows which dice to throw; the result comes back through wait_for_players. Name what is rolled and the sheet supplies dice and modifier: `check` (skill, ability, "<ability> save"), `attack` (weapon or spell, to hit) or `damage` (weapon or spell, damage or healing). Explicit `dice`/`modifier` override.',
    inputSchema: {
      character_id: z.string().describe('Character id or name.'),
      check: z.string().optional().describe('e.g. "Stealth", "Perception", "dex save", "str".'),
      attack: z.string().optional().describe('Weapon or spell to hit with, e.g. "Longsword", "Fire Bolt".'),
      damage: z.string().optional().describe('Weapon or spell whose damage (or healing) to roll, e.g. "Longsword", "Cure Wounds".'),
      critical: z.boolean().optional().describe('With `damage`: a critical hit, the dice are doubled.'),
      versatile: z.boolean().optional().describe('With `damage`: the weapon is held in two hands.'),
      label: z.string().optional().describe('What is shown. Defaults from check, attack or damage.'),
      dice: z.string().optional().describe('e.g. "1d20", "2d6". Defaults from attack/damage, else 1d20.'),
      modifier: z.number().int().optional().describe('Overrides the computed modifier.'),
      advantage: z.enum(['none', 'advantage', 'disadvantage']).default('none'),
      dc: z.number().int().optional().describe('Target number. Success is computed when given.'),
      hide_dc: z.boolean().default(true),
      game_id: gameIdArg,
    },
  }, ({ character_id, check, attack, damage, critical, versatile, label, dice: givenDice, modifier, advantage, dc, hide_dc, game_id }) => {
    const id = resolve(game_id);
    const c = character(store.state(id), character_id);
    if ([check, attack, damage].filter(Boolean).length > 1) throw new Error('Give only one of `check`, `attack` and `damage`.');
    const named = attack ? attackRoll(c, attack) : damage ? damageRoll(c, damage, { critical, versatile }) : undefined;
    const dice = givenDice ?? named?.dice ?? '1d20';
    const spec = parseDice(dice);
    physicalDice(spec, advantage);
    const deathSave = !!check && /^(death sav|kuolemanpelast)/i.test(check.trim());
    if (deathSave && c.status !== 'dying') throw new Error(`${c.name} is not dying (status ${c.status}); no death save needed.`);
    const computed = check && !deathSave ? checkModifier(c, check, store.language()) : undefined;
    const finalLabel = deathSave ? 'Death save' : label ?? named?.label ?? computed?.label;
    if (!finalLabel) throw new Error('Give a `check`, `attack`, `damage` or a `label`.');
    const rollId = randomUUID().slice(0, 8);
    const roll = deathSave
      ? { rollId, characterId: c.id, label: finalLabel, dice: '1d20', modifier: 0, advantage: 'none' as const, dc: undefined, hideDc: true, purpose: 'death_save' as const }
      : { rollId, characterId: c.id, label: finalLabel, dice, modifier: modifier ?? named?.modifier ?? computed?.modifier ?? 0, advantage, dc, hideDc: hide_dc };
    store.append(id, { type: 'roll_requested', roll });
    return text(`Asked ${c.name} to roll ${finalLabel}: ${roll.dice}${roll.advantage !== 'none' ? ` with ${roll.advantage}` : ''} ${sign(roll.modifier)} (roll id ${rollId}). The result arrives via wait_for_players.`);
  });

  server.registerTool('cancel_roll', {
    description: 'Withdraw a roll request that is no longer needed.',
    inputSchema: { roll_id: z.string(), game_id: gameIdArg },
  }, ({ roll_id, game_id }) => {
    const id = resolve(game_id);
    const before = store.state(id);
    if (!before.pendingRolls.some((r) => r.rollId === roll_id)) throw new Error(`No pending roll ${roll_id}`);
    store.append(id, { type: 'roll_cancelled', rollId: roll_id });
    const after = store.state(id);
    // Cancelling the last missing initiative roll sets the order.
    const opened = before.combat?.round === 0 && (after.combat?.round ?? 0) > 0;
    return text(`Roll cancelled.${opened ? ` Initiative order: ${orderText(after)}. ${roundText(after)}` : ''}`);
  });

  server.registerTool('dm_roll', {
    description: 'Roll virtual dice yourself, for monsters, NPCs and secret checks. Public rolls appear in the story log; secret ones only to you.',
    inputSchema: {
      label: z.string().describe('e.g. "Goblin scimitar attack", "Initiative: goblins".'),
      dice: z.string().default('1d20'),
      modifier: z.number().int().default(0),
      advantage: z.enum(['none', 'advantage', 'disadvantage']).default('none'),
      dc: z.number().int().optional(),
      secret: z.boolean().default(false),
      game_id: gameIdArg,
    },
  }, ({ label, dice, modifier, advantage, dc, secret, game_id }) => {
    const id = resolve(game_id);
    const out = virtualRoll(parseDice(dice), advantage, modifier);
    const success = dc === undefined ? undefined : out.total >= dc;
    store.append(id, {
      type: 'dm_roll', secret,
      roll: { rollId: randomUUID().slice(0, 8), characterId: '', label, dice, modifier, advantage, dc, hideDc: true, faces: out.faces, total: out.total, success, byDm: true },
    });
    return text(`${label}: ${out.faces.join(', ')} ${sign(modifier)} = ${out.total}${success === undefined ? '' : success ? ' (success)' : ' (failure)'}${out.faces.includes(20) && parseDice(dice).sides === 20 ? ' — natural 20!' : ''}`);
  });

  // ---- Characters ----------------------------------------------------------

  server.registerTool('update_character', {
    description: 'Change a character sheet: damage/healing, items, gold, XP, conditions, level, features, spells. Every change shows up on the table.',
    inputSchema: {
      character_id: z.string(),
      hp_delta: z.number().int().optional().describe('Negative for damage (temp HP absorbs first), positive for healing.'),
      hp: z.number().int().optional(),
      max_hp: z.number().int().optional(),
      temp_hp: z.number().int().optional(),
      ac: z.number().int().optional(),
      level: z.number().int().min(1).max(20).optional(),
      xp_delta: z.number().int().optional(),
      gold_delta: z.number().int().optional(),
      add_items: z.array(z.object({ name: z.string(), qty: z.number().int().optional() })).optional(),
      remove_items: z.array(z.object({ name: z.string(), qty: z.number().int().optional() })).optional(),
      add_conditions: z.array(z.string()).optional(),
      remove_conditions: z.array(z.string()).optional(),
      add_effects: z.array(z.object({ name: z.string(), note: z.string() })).optional()
        .describe('Spell or feature effects on the hero, e.g. { name: "Blessed", note: "+1d4 to attacks and saves, 1 minute" }. A long rest ends them all.'),
      remove_effects: z.array(z.string()).optional(),
      add_features: z.array(z.union([z.string(), z.object({ name: z.string(), text: z.string().default('') })])).optional()
        .describe('A name, or { name, text } with a one-line explanation the players can read.'),
      add_spells: z.array(z.union([z.string(), z.object({
        name: z.string(), level: z.union([z.literal(0), z.literal(1)]), casting_time: z.enum(['action', 'bonus', 'reaction']).default('action'),
        range: z.string(), summary: z.string(), concentration: z.boolean().optional(),
        attack: z.enum(['ranged', 'melee']).optional(), save: z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha']).optional(),
        dice: z.string().optional(), add_mod: z.boolean().optional(), damage_type: z.string().optional(), heal: z.boolean().optional(),
      })])).optional().describe(`A spell name from the built-in list (${SPELLS.map((x) => x.name).join(', ')}), or a custom spell.`),
      remove_spells: z.array(z.string()).optional(),
      notes: z.string().optional().describe('Replaces the sheet notes.'),
      resource_max: z.array(z.object({ resource: z.string(), max: z.number().int().min(0) })).optional().describe('Change a resource maximum, e.g. more spell slots after levelling.'),
      critical: z.boolean().optional().describe('The damage was a critical hit: a dying hero takes two death save failures.'),
      revive: z.boolean().optional().describe('Raise a dead hero (needs positive hp_delta or hp).'),
      reason: z.string().optional().describe('Shown in the log, e.g. "goblin arrow".'),
      game_id: gameIdArg,
    },
  }, (a) => {
    const id = resolve(a.game_id);
    const c = character(store.state(id), a.character_id);
    store.append(id, {
      type: 'character_updated', characterId: c.id, reason: a.reason,
      patch: {
        hpDelta: a.hp_delta, hp: a.hp, maxHp: a.max_hp, tempHp: a.temp_hp, ac: a.ac, level: a.level,
        xpDelta: a.xp_delta, goldDelta: a.gold_delta, addItems: a.add_items, removeItems: a.remove_items,
        addConditions: a.add_conditions, removeConditions: a.remove_conditions, addEffects: a.add_effects, removeEffects: a.remove_effects, addFeatures: a.add_features?.map((f) => (typeof f === 'string' ? f : { ...f, source: 'other' as const })), notes: a.notes,
        addSpells: a.add_spells?.map(toSpell), removeSpells: a.remove_spells, critical: a.critical, revive: a.revive,
        resourceMax: a.resource_max?.map((m) => ({ resourceId: findResource(c, m.resource).id, max: m.max })),
      },
    });
    const after = character(store.state(id), c.id);
    return text(`${after.name}: HP ${after.hp}/${after.maxHp}${after.tempHp ? ` (+${after.tempHp} temp)` : ''}, AC ${after.ac}, conditions: ${after.conditions.join(', ') || 'none'}, effects: ${after.effects.map((x) => x.name).join(', ') || 'none'}${lifeNote(after)}`);
  });

  // ---- Sketches ------------------------------------------------------------

  server.registerTool('draw_sketch', {
    description: `Show a pencil sketch on the table canvas. Send SVG elements for viewBox "0 0 ${SKETCH_WIDTH} ${SKETCH_HEIGHT}" (no <svg> wrapper needed). Read get_sketch_style first and follow it.`,
    inputSchema: { svg: z.string().min(1), caption: z.string().min(1), game_id: gameIdArg },
  }, ({ svg, caption, game_id }) => {
    const id = resolve(game_id);
    const ev = store.append(id, { type: 'sketch', caption, svg: sanitizeSketch(svg) });
    return text(`Sketch shown (seq ${ev.seq}).`);
  });

  server.registerTool('list_sketches', {
    description: 'Captions of all sketches in this game, to keep a consistent look or reuse a map.',
    inputSchema: { game_id: gameIdArg },
    annotations: { readOnlyHint: true },
  }, ({ game_id }) => {
    const s = store.state(resolve(game_id));
    return json(s.sketches.map((k, index) => ({ index, seq: k.seq, caption: k.caption, size: k.svg.length })));
  });

  server.registerTool('get_sketch', {
    description: 'The SVG of an earlier sketch (default: the latest), e.g. to redraw a map with changes.',
    inputSchema: { index: z.number().int().optional(), game_id: gameIdArg },
    annotations: { readOnlyHint: true },
  }, ({ index, game_id }) => {
    const s = store.state(resolve(game_id));
    const k = index === undefined ? s.sketches.at(-1) : s.sketches[index];
    if (!k) throw new Error('No such sketch.');
    return text(`Caption: ${k.caption}\n\n${k.svg}`);
  });

  // ---- Time travel ---------------------------------------------------------

  server.registerTool('get_history', {
    description: 'Event history with sequence numbers (seq, time, type, detail). Use with rewind.',
    inputSchema: { limit: z.number().int().min(1).max(1000).default(60), game_id: gameIdArg },
    annotations: { readOnlyHint: true },
  }, ({ limit, game_id }) => {
    const id = resolve(game_id);
    return text(store.liveEvents(id).slice(-limit).map(historyLine).join('\n'));
  });

  server.registerTool('rewind', {
    description: 'Rewind the game so that seq is the last thing that happened. Later events are hidden (kept in the DB). Only do this when the players ask.',
    inputSchema: { to_seq: z.number().int().min(1), game_id: gameIdArg },
    annotations: { destructiveHint: true },
  }, ({ to_seq, game_id }) => {
    const id = resolve(game_id);
    const s = store.rewind(id, to_seq);
    return text(`Rewound to seq ${s.seq}. Call get_game_state to re-read the situation.`);
  });

  registerSceneTools(server, store, { resolve, character });

  return server;
}
