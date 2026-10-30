import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { entryName } from './combat.ts';
import { getSetting, setSetting, type Db } from './db.ts';
import { meetsDc, parseDice, physicalDice, virtualRoll } from './dice.ts';
import { DM_GUIDE } from './dm-guide.ts';
import { armorClass, presetMods, resists, rollBonusDice } from './effects.ts';
import { lengthNudge, rollNudge } from './dm-report.ts';
import { fightRefs, orderText, registerSceneTools, roundText } from './mcp-scene.ts';
import { canLevel, levelOptions, levelUp, needsChoices, withRecommended, type LevelOptions } from './levels.ts';
import { findResource, hitDieRoll } from './resources.ts';
import { findPresence, newPresences, presenceSpec, stillPresent, toSpec, type Presence } from './roster.ts';
import { ABILITIES, checkModifier, type Character } from './rules.ts';
import { attackRoll, damageRoll, sheetOf } from './sheet.ts';
import { findSpell, SPELLS, type Spell, type SpellLevel } from './spells.ts';
import { getSketchStyle, sanitizeSketch, setSketchStyle, SKETCH_HEIGHT, SKETCH_WIDTH } from './sketch.ts';
import type { DamageTarget, GameState, StoredEvent } from './state.ts';
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
      if (r.purpose === 'concentration') {
        const held = e.success ? 'holds on to their spell' : 'loses concentration; their spell ends (the engine removed its effects)';
        return `[${seq}] CONCENTRATION ${who(r.characterId)}: ${e.faces.join(', ')} ${sign(r.modifier)} = ${e.total} vs DC ${r.dc} → ${who(r.characterId)} ${held}.`;
      }
      if (r.purpose === 'death_save') {
        const c = s.characters.find((x) => x.id === r.characterId);
        const face = e.faces[0];
        const saves = c ? ` (saves ${c.deathSaves.successes}, fails ${c.deathSaves.failures})` : '';
        const end = c?.status === 'stable' ? ` ${c.name} is stable.` : face === 20 ? ` ${who(r.characterId)} is back up with 1 HP!` : '';
        return `[${seq}] DEATH SAVE ${who(r.characterId)}: ${face} → ${face === 20 ? 'natural 20' : face === 1 ? 'natural 1, two failures' : face >= 10 ? 'success' : 'failure'}${saves}${end}`;
      }
      const aimed = r.targetId ? s.present.find((p) => p.id === r.targetId) : undefined;
      const bonus = e.bonusFaces?.length ? ` + ${r.bonusDice?.map((b) => b.from).join(', ')} ${e.bonusFaces.join(', ')}` : '';
      const vs = r.dc === undefined ? ''
        : aimed && r.critOn !== undefined ? ` vs ${aimed.id} AC ${r.dc} → ${e.success ? `HIT: request_roll damage with target "${aimed.id}"` : 'MISS'}`
        : ` vs DC ${r.dc} → ${e.success ? 'SUCCESS' : 'FAILURE'}`;
      const kept = r.advantage === 'advantage' ? Math.max(...e.faces) : r.advantage === 'disadvantage' ? Math.min(...e.faces) : e.faces[0];
      const crit = r.critOn === undefined ? '' : kept >= r.critOn ? ` — CRITICAL HIT${kept < 20 ? ` (${kept} is a critical for ${who(r.characterId)})` : ''}: roll damage with \`critical\`` : kept === 1 ? ' — natural 1, a miss' : '';
      const dealt = r.targets ? ` → ${r.heal ? 'healing' : 'damage'} applied: ${damageReport(s, r.targets, e.total, r.heal)}`
        : aimed && r.critOn === undefined ? ` → ${Math.max(0, e.total)} damage applied to ${aimed.id}: ${aimed.hp}/${aimed.maxHp} HP${aimed.defeated ? ', DEFEATED' : ''}` : '';
      const lastInitiative = r.purpose === 'initiative' && s.combat && s.combat.round > 0
        && s.rolls.findLast((x) => x.purpose === 'initiative') === r;
      const order = lastInitiative ? ` Initiative order: ${orderText(s)}. ${roundText(s)}` : '';
      return `[${seq}] ROLL ${who(r.characterId)} — ${r.label}: dice ${e.faces.join(', ')}${r.advantage !== 'none' ? ` (${r.advantage})` : ''} ${sign(r.modifier)}${bonus} = ${e.total}${vs}${crit}${dealt}${order}`;
    }
    case 'character_created': {
      const c = e.character;
      return `[${seq}] NEW CHARACTER ${c.name} (id ${c.id}), played by ${c.player || '?'}: level ${c.level} ${c.race} ${c.className}, HP ${c.maxHp}, AC ${c.ac}`;
    }
    case 'character_levelled':
      return `[${seq}] LEVEL UP: ${s.log.find((l) => l.seq === seq)?.text ?? who(e.characterId)}. Describe the new powers in the story.`;
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

function gainsText(o: LevelOptions): string {
  return [`+${o.hp} HP`, `proficiency +${o.proficiency}`, o.speed && `+${o.speed} ft speed`,
    o.features.length && `features: ${o.features.map((f) => f.name).join(', ')}`,
    o.spells.length && `spells: ${o.spells.map((s) => s.name).join(', ')}`,
    `uses: ${o.resources.map((r) => `${r.name} ${r.max}`).join(', ')}`].filter(Boolean).join('; ');
}

function choicesText(o: LevelOptions): string {
  const ch = o.choices;
  return [ch.asi && 'ability scores (+2)', ch.cantrips && `${ch.cantrips.count} cantrip(s)`, ch.spells && `${ch.spells.count} spell(s)`,
    ch.skills && `${ch.skills.count} skills`, ch.expertise && `${ch.expertise.count} Expertise skills`].filter(Boolean).join(', ');
}

const levelHint = (c: Character) => (canLevel(c) && !c.pendingLevel
  ? `. ${c.name} has enough XP for level ${c.level + 1}: call level_up when the story allows (between scenes, after a rest).` : '');

type SpellArg = string | {
  name: string; level: SpellLevel; casting_time: Spell['castingTime']; range: string; summary: string; concentration?: boolean;
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

const TAKES = { full: 1, half: 0.5, none: 0, double: 2 } as const;
const targetsArg = z.array(z.union([z.string(), z.object({
  who: z.string().describe('A hero (id or name) or a creature id such as "goblin-2".'),
  takes: z.enum(['full', 'half', 'none', 'double']).describe('half: made the save, or resists; double: vulnerable; none: immune or dodged it all.'),
})])).optional();

/**
 * Who a damage roll hits and how much of it each takes. Without an explicit `takes`, a hero whose
 * effects resist the damage type (Rage against slashing) takes half by themselves.
 */
function damageTargets(s: GameState, list: z.infer<typeof targetsArg> & {}, damageType: string | undefined, critical?: boolean, heal = false): DamageTarget[] {
  return list.map((t) => {
    const who = typeof t === 'string' ? t : t.who;
    const hero = s.characters.find((x) => x.id === who || x.name.toLowerCase() === who.toLowerCase());
    if (hero) {
      if (hero.status === 'dead') throw new Error(`${hero.name} is dead${heal ? '; only update_character with revive raises the dead' : ''}.`);
      const factor = typeof t === 'string' ? (!heal && resists(hero, damageType) ? 0.5 : 1) : TAKES[t.takes];
      return { kind: 'hero' as const, id: hero.id, ...(factor !== 1 ? { factor } : {}), ...(critical ? { critical } : {}) };
    }
    const p = findPresence(s.present, who);
    if (p.defeated && !heal) throw new Error(`${p.id} is already defeated.`);
    if (p.hp === undefined) throw new Error(`${p.id} has no HP to lose. Leave it out of the targets.`);
    const factor = typeof t === 'string' ? 1 : TAKES[t.takes];
    return { kind: 'creature' as const, id: p.id, ...(factor !== 1 ? { factor } : {}) };
  });
}

/** "5 to goblin-1 (0/7 HP, DEFEATED); 2 to Mira, half (8/10 HP)" — read after the damage went in. */
function damageReport(s: GameState, targets: DamageTarget[], total: number, heal = false): string {
  return targets.map((t) => {
    const dealt = `${heal ? '+' : ''}${Math.floor(Math.max(0, total) * (t.factor ?? 1))}`;
    const share = t.factor === undefined ? '' : t.factor === 0.5 ? ', half' : t.factor === 2 ? ', double' : t.factor === 0 ? ', none' : '';
    if (t.kind === 'hero') {
      const c = s.characters.find((x) => x.id === t.id)!;
      return `${dealt} to ${c.name}${share} (HP ${c.hp}/${c.maxHp}${c.status !== 'up' ? `, ${c.status}` : ''})`;
    }
    const p = s.present.find((x) => x.id === t.id);
    return `${dealt} to ${t.id}${share} (${p ? `${p.hp}/${p.maxHp} HP${p.defeated ? ', DEFEATED' : ''}` : 'gone'})`;
  }).join('; ');
}

/** A save the engine just asked of a hero who was hurt while concentrating. */
function concentrationNote(s: GameState, c: Character): string {
  const save = s.pendingRolls.findLast((r) => r.purpose === 'concentration' && r.characterId === c.id);
  return save ? ` ${c.name} is concentrating: the engine asked for a concentration save (DC ${save.dc}); on a failure the spell's effects end by themselves.` : '';
}

function lifeNote(c: Character): string {
  const saves = `saves ${c.deathSaves.successes}, fails ${c.deathSaves.failures}`;
  if (c.status === 'dying') return `. ${c.name} is dying (${saves}). Death saves are asked automatically on ${c.name}'s turn in combat; outside combat use request_roll with check "death save". A Medicine check or Spare the Dying: update_character with stabilize.`;
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
    e.type === 'dm_note' ? `note: ${short(e.text)}` :
    e.type === 'dm_note_edited' ? `note ${e.noteSeq}: ${e.text === undefined ? 'retired' : short(e.text)}` : '';
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
      language: `${LANGUAGE_NAMES[store.language(id)]}: write everything the players see in this language.`,
      complexity: COMPLEXITY_GUIDE[store.complexity(id)],
      verbosity: VERBOSITY_GUIDE[store.verbosity(id)],
      fallenHeroes: FALLEN_GUIDE[store.fallenHeroes(id)],
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
    const header = [...notices, `(Table language: ${LANGUAGE_NAMES[store.language(id)]}. Complexity: ${store.complexity(id)}. Verbosity: ${store.verbosity(id)}/4. When a hero falls: ${store.fallenHeroes(id)}.)`].join('\n');
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
    const before = store.state(id);
    const spoke = before.log.findLast((l) => l.from === 'dm' && l.kind !== 'ooc')?.seq ?? 0;
    const rollsInPlay = before.pendingRolls.length + before.rolls.filter((r) => !r.byDm && r.requestedSeq > spoke).length;
    const ev = store.append(id, { type: 'message', from: 'dm', kind, characterId, text: t });
    const nudge = kind === 'ooc' ? '' : lengthNudge(t, store.verbosity(id)) + rollNudge(t, rollsInPlay);
    return text(`Shown to the table (seq ${ev.seq}).${nudge}${sketchReminder(store.state(id))}`);
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
    return text(`Noted (note ${ev.seq}).`);
  });

  server.registerTool('edit_dm_note', {
    description: 'Rewrite one of your notes when a fact changes (an NPC died, a secret came out), or retire it when it no longer matters. Notes are numbered by the seq they were added at, as get_game_state lists them.',
    inputSchema: {
      note: z.number().int().describe('The note\'s seq.'),
      text: z.string().min(1).optional().describe('The new text. Leave out with `retire`.'),
      retire: z.boolean().default(false).describe('Drop the note from your notebook. It stays in the history.'),
      game_id: gameIdArg,
    },
  }, ({ note, text: t, retire, game_id }) => {
    const id = resolve(game_id);
    const notes = store.state(id).dmNotes;
    if (!notes.some((n) => n.seq === note)) throw new Error(`No note ${note}. Notes: ${notes.map((n) => n.seq).join(', ') || 'none'}.`);
    if (retire === (t !== undefined)) throw new Error('Give either `text` or `retire`.');
    store.append(id, { type: 'dm_note_edited', noteSeq: note, ...(retire ? {} : { text: t }) });
    return text(retire ? `Note ${note} retired.` : `Note ${note} rewritten.`);
  });

  // ---- Dice ----------------------------------------------------------------

  server.registerTool('request_roll', {
    description: 'Ask a player to throw physical dice. The page shows which dice to throw; the result comes back through wait_for_players. Name what is rolled and the sheet supplies dice and modifier: `check` (skill, ability, "<ability> save"), `attack` (weapon or spell, to hit) or `damage` (weapon or spell, damage or healing). Explicit `dice`/`modifier` override.',
    inputSchema: {
      character_id: z.string().describe('Character id or name.'),
      check: z.string().optional().describe('e.g. "Stealth", "Perception", "dex save", "str".'),
      attack: z.string().optional().describe('Weapon or spell to hit with, e.g. "Longsword", "Fire Bolt".'),
      damage: z.string().optional().describe('Weapon or spell whose damage (or healing) to roll, e.g. "Longsword", "Cure Wounds".'),
      target: z.string().optional().describe('With `attack` or `damage`: the creature in the scene it is aimed at (id such as "goblin-2"). An attack is then checked against its AC (hit or miss), and damage comes off its HP by itself. Leave out for resistance or anything the engine should not apply as is.'),
      targets: targetsArg.describe('With `damage`: everyone it hits (an area spell like Thunderwave or Burning Hands), each taking full, half (made the save, resists), double or none. Heroes and creatures alike; the damage applies itself to each.'),
      heal: z.boolean().optional().describe('A roll of your own (label, dice) that heals its targets instead (a potion, a blessing). Healing spells heal by themselves.'),
      damage_type: z.string().optional().describe('Damage type of a roll of your own, so resistances apply.'),
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
  }, ({ character_id, check, attack, damage, target, targets, heal, damage_type, critical, versatile, label, dice: givenDice, modifier, advantage, dc, hide_dc, game_id }) => {
    const id = resolve(game_id);
    const c = character(store.state(id), character_id);
    if ([check, attack, damage].filter(Boolean).length > 1) throw new Error('Give only one of `check`, `attack` and `damage`.');
    const named = attack ? attackRoll(c, attack) : damage ? damageRoll(c, damage, { critical, versatile }) : undefined;
    // A roll of the DM's own (a trap, a potion bomb): label and dice, aimed at targets.
    const own = !attack && !damage && !check && (target || targets?.length);
    if (own && !givenDice) throw new Error('A roll of your own with `target` / `targets` needs its `dice` (and a `label`).');
    if (targets?.length && attack) throw new Error('An attack has one `target`; `targets` are for damage (an area spell, a blast).');
    if ((target || targets?.length) && check) throw new Error('`target` and `targets` go with `attack`, `damage` or a roll of your own (`label` and `dice`).');
    const healing = heal || named?.action.kind === 'healing';
    const aim = attack && target !== undefined ? findPresence(store.state(id).present, target) : undefined;
    if (aim) {
      if (aim.defeated) throw new Error(`${aim.id} is already defeated.`);
      if (aim.ac === undefined) throw new Error(`${aim.id} has no AC. Give it one with update_presence, or leave out \`target\` and compare yourself.`);
      if (dc !== undefined) throw new Error('With `target` the DC is the target\'s AC; leave out `dc`.');
    }
    const hits = (damage || own) && (target || targets?.length)
      ? damageTargets(store.state(id), [...(target ? [target] : []), ...(targets ?? [])], damage_type ?? named?.damageType, false, healing) : undefined;
    // A breath weapon is spent when it is breathed.
    const breath = named?.action.id === 'Breath Weapon' ? findResource(c, 'breath-weapon') : undefined;
    if (breath && breath.used >= breath.max) throw new Error(`${c.name} has used their Breath Weapon; it comes back after a short rest.`);
    const deathSave = !!check && /^(death sav|kuolemanpelast)/i.test(check.trim());
    const pendingDice = store.state(id).pendingRolls.filter((r) => r.purpose === 'hit_die' && r.characterId === c.id).length;
    const hitDie = check && /^(hit di|osumanop)/i.test(check.trim()) ? hitDieRoll(c, pendingDice) : undefined;
    const dice = givenDice ?? named?.dice ?? hitDie?.dice ?? '1d20';
    const spec = parseDice(dice);
    physicalDice(spec, advantage);
    if (deathSave && c.status !== 'dying') throw new Error(`${c.name} is not dying (status ${c.status}); no death save needed.`);
    const computed = check && !deathSave && !hitDie ? checkModifier(c, check, store.language(id)) : undefined;
    const finalLabel = deathSave ? 'Death save' : hitDie ? hitDie.label : label ?? named?.label ?? computed?.label;
    if (!finalLabel) throw new Error('Give a `check`, `attack`, `damage` or a `label`.');
    const rollId = randomUUID().slice(0, 8);
    const roll = deathSave
      ? { rollId, characterId: c.id, label: finalLabel, dice: '1d20', modifier: 0, advantage: 'none' as const, dc: undefined, hideDc: true, purpose: 'death_save' as const }
      : { rollId, characterId: c.id, label: finalLabel, dice, modifier: modifier ?? named?.modifier ?? computed?.modifier ?? 0, advantage,
        ...(attack && aim ? { dc: aim.ac, hideDc: true } : { dc, hideDc: hide_dc }),
        ...(attack ? { critOn: named?.critOn ?? 20 } : {}), ...(aim ? { targetId: aim.id } : {}), ...(hits ? { targets: hits, ...(healing ? { heal: true } : {}) } : {}), ...(named && !label ? { action: named.action } : {}),
        ...(hitDie ? { modifier: hitDie.modifier, purpose: hitDie.purpose, dc: undefined } : {}),
        // Bless and the like add their die to attacks and saving throws.
        ...((attack || (check && /save|pelastus/i.test(check))) && rollBonusDice(c).length ? { bonusDice: rollBonusDice(c) } : {}) };
    store.append(id, { type: 'roll_requested', roll });
    if (breath) store.append(id, { type: 'resource_used', characterId: c.id, resourceId: breath.id, amount: 1 });
    const breathDc = breath ? `. Breath Weapon: the targets save DEX against DC ${8 + Math.floor((c.abilities.con - 10) / 2) + c.proficiencyBonus}; its use is spent until a short rest` : '';
    const against = aim ? aim.id : hits?.map((x) => `${x.id}${x.factor === 0.5 ? ' (half)' : x.factor === 2 ? ' (double)' : x.factor === 0 ? ' (none)' : ''}`).join(', ');
    return text(`Asked ${c.name} to roll ${finalLabel}${against ? ` against ${against}` : ''}: ${roll.dice}${roll.advantage !== 'none' ? ` with ${roll.advantage}` : ''} ${sign(roll.modifier)} (roll id ${rollId})${breathDc}. The result arrives via wait_for_players.`);
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
    description: 'Roll virtual dice yourself, for monsters, NPCs and secret checks. Public rolls appear in the story log; secret ones only to you. ' +
      'A monster\'s attack: give `target` (a hero, or a creature in the scene) and the d20 is checked against its AC, effects included. ' +
      'Its damage: `damage` true with `target` or `targets` (an area, a breath), and it comes off their HP; give `damage_type` so resistances (Rage) halve it by themselves.',
    inputSchema: {
      label: z.string().describe('e.g. "Goblin scimitar attack", "Initiative: goblins".'),
      dice: z.string().default('1d20'),
      modifier: z.number().int().default(0),
      advantage: z.enum(['none', 'advantage', 'disadvantage']).default('none'),
      dc: z.number().int().optional(),
      target: z.string().optional().describe('Who the attack or damage is aimed at: a hero (id or name) or a creature id such as "goblin-2".'),
      damage: z.boolean().default(false).describe('This roll is damage, not an attack: it is applied to `target` / `targets`.'),
      targets: targetsArg.describe('With `damage`: everyone it hits, each taking full, half (made the save), double or none. A plain name lets resistances decide.'),
      damage_type: z.string().optional().describe('With `damage`: slashing, piercing, bludgeoning, fire, poison… Heroes who resist it take half.'),
      critical: z.boolean().optional().describe('With `damage`: a critical hit. The dice are doubled, and a dying hero takes two death save failures.'),
      secret: z.boolean().default(false),
      game_id: gameIdArg,
    },
  }, ({ label, dice, modifier, advantage, dc, target, damage, targets, damage_type, critical, secret, game_id }) => {
    const id = resolve(game_id);
    const s = store.state(id);
    const aimed = [...(target ? [target] : []), ...(targets ?? [])];
    if (!aimed.length && (damage || critical)) throw new Error('`damage` and `critical` go with a `target` or `targets`.');
    if (!damage && targets?.length) throw new Error('`targets` are for damage; an attack has one `target`.');
    let attack = {};
    let attackOn: { name: string; ac: number } | undefined;
    if (target && !damage) {
      const hero = s.characters.find((x) => x.id === target || x.name.toLowerCase() === target.toLowerCase());
      const creature = hero ? undefined : findPresence(s.present, target);
      if (dc !== undefined) throw new Error('With `target` the DC is the target\'s AC; leave out `dc`.');
      if (creature && creature.ac === undefined) throw new Error(`${creature.id} has no AC. Give it one with update_presence, or leave out \`target\`.`);
      if (creature?.defeated) throw new Error(`${creature.id} is already defeated.`);
      if (hero?.status === 'dead') throw new Error(`${hero.name} is dead.`);
      if (parseDice(dice).sides !== 20 || parseDice(dice).count !== 1) throw new Error('An attack is one d20. For damage, add `damage: true`.');
      attackOn = { name: hero?.name ?? creature!.id, ac: hero ? armorClass(hero) : creature!.ac! };
      attack = { dc: attackOn.ac, critOn: 20, targetId: hero?.id ?? creature!.id };
    }
    const hits = damage ? damageTargets(s, aimed, damage_type, critical) : undefined;
    const rolled = critical ? dice.replace(/^\s*(\d*)\s*d/i, (_, n) => `${2 * Number(n || 1)}d`) : dice;
    const out = virtualRoll(parseDice(rolled), advantage, modifier);
    const roll = { rollId: randomUUID().slice(0, 8), characterId: '', label, dice: rolled, modifier, advantage, dc, hideDc: true, ...attack, faces: out.faces, total: out.total };
    const success = meetsDc(roll, out.faces, out.total);
    store.append(id, { type: 'dm_roll', secret, roll: { ...roll, success, byDm: true }, ...(hits ? { damageTo: hits } : {}) });
    const head = `${label}: ${out.faces.join(', ')} ${sign(modifier)} = ${out.total}`;
    if (attackOn) {
      const d20 = advantage === 'advantage' ? Math.max(...out.faces) : advantage === 'disadvantage' ? Math.min(...out.faces) : out.faces[0];
      return text(`${head} vs ${attackOn.name} AC ${attackOn.ac} → ${d20 === 20 ? 'CRITICAL HIT: roll damage with `critical`' : success ? 'HIT' : d20 === 1 ? 'natural 1, a MISS' : 'MISS'}` +
        `${success ? `. Roll the damage: dm_roll with target "${attackOn.name}", damage true and its damage_type.` : '.'}`);
    }
    if (hits) {
      const after = store.state(id);
      const notes = hits.filter((x) => x.kind === 'hero').map((x) => { const c = character(after, x.id); return `${lifeNote(c).replace(/^\. /, ' ')}${concentrationNote(after, c)}`; }).join('');
      return text(`${head} → ${damageReport(after, hits, out.total)}.${notes}`);
    }
    return text(`${head}${success === undefined ? '' : success ? ' (success)' : ' (failure)'}${out.faces.includes(20) && parseDice(dice).sides === 20 ? ' — natural 20!' : ''}`);
  });

  // ---- Characters ----------------------------------------------------------

  server.registerTool('update_character', {
    description: 'Change a character sheet: damage/healing, items, gold, XP, conditions, features, spells. Every change shows up on the table. Levels go through level_up.',
    inputSchema: {
      character_id: z.string(),
      hp_delta: z.number().int().optional().describe('Negative for damage (temp HP absorbs first), positive for healing.'),
      hp: z.number().int().optional(),
      max_hp: z.number().int().optional(),
      temp_hp: z.number().int().optional(),
      ac: z.number().int().optional(),
      xp_delta: z.number().int().optional(),
      gold_delta: z.number().int().optional(),
      add_items: z.array(z.object({ name: z.string(), qty: z.number().int().min(0).optional(), note: z.string().optional() })).optional()
        .describe('Keep the name short and put what an unusual item is or does in `note`; players see it on the sheet. qty 0 with a note changes only the note.'),
      remove_items: z.array(z.object({ name: z.string(), qty: z.number().int().optional() })).optional(),
      add_conditions: z.array(z.string()).optional(),
      remove_conditions: z.array(z.string()).optional(),
      add_effects: z.array(z.object({ name: z.string(), note: z.string(),
        concentration: z.string().optional().describe('The hero (id or name) concentrating on the spell. The engine then asks them for a concentration save when they are hurt, and ends the effect when they fail, fall or start another concentration spell.'),
        ac_bonus: z.number().int().optional().describe('Added to AC while it lasts. Known effects (Mage Armor, Shield of Faith, Shield, Rage) get their numbers by name.'),
        melee_damage: z.number().int().optional().describe('Added to Strength melee weapon damage.'),
        resist: z.array(z.string()).optional().describe('Damage types halved while it lasts, e.g. ["fire"].') })).optional()
        .describe('Spell or feature effects on the hero, e.g. { name: "Blessed", note: "+1d4 to attacks and saves, 1 minute", concentration: "Halla" }. A long rest ends them all.'),
      remove_effects: z.array(z.string()).optional(),
      add_features: z.array(z.union([z.string(), z.object({ name: z.string(), text: z.string().default('') })])).optional()
        .describe('A name, or { name, text } with a one-line explanation the players can read.'),
      add_spells: z.array(z.union([z.string(), z.object({
        name: z.string(), level: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]), casting_time: z.enum(['action', 'bonus', 'reaction']).default('action'),
        range: z.string(), summary: z.string(), concentration: z.boolean().optional(),
        attack: z.enum(['ranged', 'melee']).optional(), save: z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha']).optional(),
        dice: z.string().optional(), add_mod: z.boolean().optional(), damage_type: z.string().optional(), heal: z.boolean().optional(),
      })])).optional().describe(`A spell name from the built-in list (${SPELLS.map((x) => x.name).join(', ')}), or a custom spell.`),
      remove_spells: z.array(z.string()).optional(),
      notes: z.string().optional().describe('Replaces the sheet notes: things the player wants to remember (debts, names, promises). Never spell slots, uses or HP: those have their own counters (use_resource).'),
      resource_max: z.array(z.object({ resource: z.string(), max: z.number().int().min(0) })).optional().describe('Change a resource maximum, e.g. more spell slots after levelling.'),
      critical: z.boolean().optional().describe('The damage was a critical hit: a dying hero takes two death save failures.'),
      revive: z.boolean().optional().describe('Raise a dead hero (needs positive hp_delta or hp).'),
      stabilize: z.boolean().optional().describe('A dying hero stops dying (a Medicine check, Spare the Dying): stable and unconscious at 0 HP, no more death saves.'),
      reason: z.string().optional().describe('Shown in the log, e.g. "goblin arrow".'),
      game_id: gameIdArg,
    },
  }, (a) => {
    const id = resolve(a.game_id);
    const c = character(store.state(id), a.character_id);
    store.append(id, {
      type: 'character_updated', characterId: c.id, reason: a.reason,
      patch: {
        hpDelta: a.hp_delta, hp: a.hp, maxHp: a.max_hp, tempHp: a.temp_hp, ac: a.ac,
        xpDelta: a.xp_delta, goldDelta: a.gold_delta, addItems: a.add_items, removeItems: a.remove_items,
        addConditions: a.add_conditions, removeConditions: a.remove_conditions, addEffects: a.add_effects?.map(({ concentration, ac_bonus, melee_damage, resist, ...x }) => {
          const own = { ...(ac_bonus ? { ac: ac_bonus } : {}), ...(melee_damage ? { meleeDamage: melee_damage } : {}), ...(resist?.length ? { resist: resist.map((r) => r.toLowerCase()) } : {}) };
          const mods = Object.keys(own).length ? own : presetMods(c, x.name);
          return { ...x, ...(concentration ? { by: character(store.state(id), concentration).id } : {}), ...(mods ? { mods } : {}) };
        }), removeEffects: a.remove_effects, addFeatures: a.add_features?.map((f) => (typeof f === 'string' ? f : { ...f, source: 'other' as const })), notes: a.notes,
        addSpells: a.add_spells?.map(toSpell), removeSpells: a.remove_spells, critical: a.critical, revive: a.revive, stabilize: a.stabilize,
        resourceMax: a.resource_max?.map((m) => ({ resourceId: findResource(c, m.resource).id, max: m.max })),
      },
    });
    const after = character(store.state(id), c.id);
    return text(`${after.name}: HP ${after.hp}/${after.maxHp}${after.tempHp ? ` (+${after.tempHp} temp)` : ''}, AC ${armorClass(after)}, conditions: ${after.conditions.join(', ') || 'none'}, effects: ${after.effects.map((x) => x.name).join(', ') || 'none'}${lifeNote(after)}${levelHint(after)}${concentrationNote(store.state(id), after)}`);
  });

  server.registerTool('level_up', {
    description: 'Raise a hero one level (up to 5). The engine applies everything the rules decide: HP, proficiency, features, uses, spell slots. When there are choices (new spells, ability scores at level 4, a bard\'s skills), the player makes them on the page and the result reaches you through wait_for_players. Pass `choices`, or `pick: "recommended"`, only when the table asks you to choose.',
    inputSchema: {
      character_id: z.string(),
      pick: z.enum(['player', 'recommended']).default('player').describe('"recommended" applies the recommended picks at once.'),
      choices: z.object({
        asi: z.record(z.enum(ABILITIES), z.number().int()).optional().describe('Level 4: +2 to one ability or +1 to two, e.g. {"wis": 2}.'),
        spells: z.array(z.string()).optional(),
        cantrips: z.array(z.string()).optional(),
        skills: z.array(z.string()).optional(),
        expertise: z.array(z.string()).optional(),
      }).optional().describe('Choices made at the table. Anything left out gets the recommended pick.'),
      game_id: gameIdArg,
    },
  }, (a) => {
    const id = resolve(a.game_id);
    const c = character(store.state(id), a.character_id);
    const o = levelOptions(c);
    if (a.choices || a.pick === 'recommended' || !needsChoices(o)) {
      const gains = levelUp(c, withRecommended(o, a.choices));
      const ev = store.append(id, { type: 'character_levelled', characterId: c.id, gains, by: 'dm' });
      return text(`${store.state(id).log.find((l) => l.seq === ev.seq)?.text}. Describe the new powers in the story.`);
    }
    store.append(id, { type: 'level_up_offered', characterId: c.id, level: o.level });
    return text(`${c.name} can reach level ${o.level}: ${gainsText(o)}. The player is choosing on the page: ${choicesText(o)}. The result arrives through wait_for_players; carry on meanwhile.`);
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

/**
 * A DM session keeps the tool list it fetched when it connected, so after a server update it may be
 * missing new tools or arguments. On start, compare the tools with the last run's and, if they
 * changed, tell the DM which ones and how to pick them up.
 */
export async function announceToolChanges(store: GameStore, db: Db): Promise<string | undefined> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(store, db);
  await server.connect(b);
  const client = new Client({ name: 'self', version: '0' });
  await client.connect(a);
  const { tools } = await client.listTools();
  await client.close();
  const now: Record<string, string> = Object.fromEntries(tools.map((t) =>
    [t.name, createHash('sha256').update(JSON.stringify([t.description, t.inputSchema])).digest('hex').slice(0, 12)]));
  const saved = getSetting(db, 'mcp_tools');
  setSetting(db, 'mcp_tools', JSON.stringify(now));
  if (!saved) return undefined;
  const before: Record<string, string> = JSON.parse(saved);
  const added = Object.keys(now).filter((n) => !(n in before));
  const changed = Object.keys(now).filter((n) => n in before && before[n] !== now[n]);
  const removed = Object.keys(before).filter((n) => !(n in now));
  if (!added.length && !changed.length && !removed.length) return undefined;
  const notice = 'SERVER UPDATED: the table\'s tools changed.' +
    [added.length && ` New: ${added.join(', ')}.`, changed.length && ` Changed: ${changed.join(', ')}.`, removed.length && ` Gone: ${removed.join(', ')}.`].filter(Boolean).join('') +
    ' If your tool list lacks these or their new arguments, it is from before the update: ask the user to run /mcp and reconnect the dnd server.' +
    ' Read get_dm_guide again for how to use them.';
  const active = store.activeGameId();
  if (active) store.notifyDm(active, notice);
  return notice;
}
