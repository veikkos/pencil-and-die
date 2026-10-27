import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { currentActor, entryName, groupEntry, heroEntry, planNextTurn, planStartCombat, sameRef, type CombatEntry } from './combat.ts';
import { parseDice, virtualRoll } from './dice.ts';
import { findResource, useResource } from './resources.ts';
import { findPresence, newPresences, presenceSpec, type PresencePatch } from './roster.ts';
import type { Character } from './rules.ts';
import type { GameState } from './state.ts';
import type { GameStore } from './store.ts';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const gameIdArg = z.string().optional().describe('Game id. Defaults to the game currently open on the table.');

/** "Round 2 — Mira's turn." and friends, for the actor whose turn it is now. */
function turnText(s: GameState): string {
  const actor = currentActor(s);
  if (!actor) return 'No one can act.';
  const head = `Round ${s.combat!.round} — `;
  const name = entryName(s, actor);
  if (actor.ref.kind === 'hero') {
    const id = actor.ref.id;
    const dying = s.characters.find((c) => c.id === id)?.status === 'dying';
    return dying ? `${head}${name} is dying: asked for ${name}'s death save.` : `${head}${name}'s turn.`;
  }
  const groupId = actor.ref.groupId;
  const members = s.present.filter((p) => p.groupId === groupId && !p.defeated).map((p) => p.id);
  return `${head}${name}${members.length > 1 ? ` (${members.join(', ')})` : ''}'s turn: act for them, then call next_turn.`;
}

/** "Mira 30, Goblin 14, Torvald 1" — DM-only, it has the totals. */
export function orderText(s: GameState): string {
  return s.combat ? s.combat.order.map((e) => `${entryName(s, e)} ${e.initiative ?? '?'}`).join(', ') : '';
}

export function roundText(s: GameState): string {
  const actor = currentActor(s);
  return actor ? `Round ${s.combat!.round}: ${entryName(s, actor)}'s turn.` : 'No one can act.';
}

const d20 = () => virtualRoll(parseDice('1d20'), 'none', 0).faces[0];

interface Helpers {
  resolve(gameId?: string): string;
  character(s: GameState, id: string): Character;
}

export function registerSceneTools(server: McpServer, store: GameStore, h: Helpers): void {
  server.registerTool('use_resource', {
    description: 'Spend (or with a negative amount, restore) a limited-use ability: a spell slot, Rage, Second Wind, Lay on Hands HP, a hit die. Fails when none are left.',
    inputSchema: {
      character_id: z.string(),
      resource: z.string().describe('Resource id or name, e.g. "rage" or "Spell slots (1st)".'),
      amount: z.number().int().default(1),
      game_id: gameIdArg,
    },
  }, (a) => {
    const id = h.resolve(a.game_id);
    const c = h.character(store.state(id), a.character_id);
    const r = findResource(c, a.resource);
    useResource(c, r.id, a.amount);
    store.append(id, { type: 'resource_used', characterId: c.id, resourceId: r.id, amount: a.amount });
    const after = findResource(h.character(store.state(id), c.id), r.id);
    return text(`${c.name}: ${after.name} ${after.max - after.used}/${after.max} left`);
  });

  server.registerTool('rest', {
    description: 'The party takes a short or long rest. Short refills short-rest abilities. Long also restores HP to max, refills everything and gives back half the hit dice.',
    inputSchema: {
      kind: z.enum(['short', 'long']),
      character_ids: z.array(z.string()).optional().describe('Defaults to everyone.'),
      game_id: gameIdArg,
    },
  }, (a) => {
    const id = h.resolve(a.game_id);
    const s = store.state(id);
    const ids = a.character_ids ? a.character_ids.map((x) => h.character(s, x).id) : s.characters.map((c) => c.id);
    store.append(id, { type: 'rest', kind: a.kind, characterIds: ids });
    return text(`${a.kind} rest taken by ${ids.map((x) => h.character(s, x).name).join(', ') || 'nobody'}.`);
  });

  server.registerTool('add_to_scene', {
    description: 'Put creatures in the scene: enemies, neutrals (a shopkeeper) or allies. Players see the name, description, conditions and a health word, never HP, AC or notes. `count` adds several identical creatures with their own HP.',
    inputSchema: { ...presenceSpec.shape, initiative: z.number().int().optional().describe('Initiative total, for joining a fight already under way.'), game_id: gameIdArg },
  }, (a) => {
    const id = h.resolve(a.game_id);
    const made = newPresences(store.state(id).present, { name: a.name, side: a.side, description: a.description, hp: a.hp, ac: a.ac, initiativeBonus: a.initiative_bonus, notes: a.notes }, a.count);
    store.append(id, { type: 'presence_added', presences: made });
    const added = `Added ${made.map((p) => p.id).join(', ')}.`;
    if (!store.state(id).combat) return text(added);
    if (a.initiative === undefined) return text(`${added} They are not in the fight; use add_to_combat to bring them in.`);
    store.append(id, { type: 'combatant_added', entry: groupEntry(store.state(id), made[0].groupId, () => a.initiative!) });
    return text(`${added} Joined the fight at initiative ${a.initiative}.`);
  });

  server.registerTool('update_presence', {
    description: 'Change a creature in the scene: damage or healing (hp_delta), conditions, side (a neutral turns hostile), description, or defeat. HP reaching 0 defeats it.',
    inputSchema: {
      presence_id: z.string().describe('Creature id such as "goblin-2", or its name when only one is alive.'),
      hp_delta: z.number().int().optional(),
      hp: z.number().int().optional(),
      max_hp: z.number().int().optional(),
      ac: z.number().int().optional(),
      side: z.enum(['enemy', 'neutral', 'ally']).optional(),
      description: z.string().optional(),
      add_conditions: z.array(z.string()).optional(),
      remove_conditions: z.array(z.string()).optional(),
      notes: z.string().optional(),
      defeated: z.boolean().optional(),
      reason: z.string().optional(),
      game_id: gameIdArg,
    },
  }, (a) => {
    const id = h.resolve(a.game_id);
    const p = findPresence(store.state(id).present, a.presence_id);
    const patch: PresencePatch = {
      hpDelta: a.hp_delta, hp: a.hp, maxHp: a.max_hp, ac: a.ac, side: a.side, description: a.description,
      addConditions: a.add_conditions, removeConditions: a.remove_conditions, notes: a.notes, defeated: a.defeated,
    };
    store.append(id, { type: 'presence_updated', presenceId: p.id, patch, reason: a.reason });
    const after = findPresence(store.state(id).present, p.id);
    return text(`${after.id}: ${after.hp !== undefined ? `${after.hp}/${after.maxHp} HP` : 'no HP tracked'}${after.defeated ? ', defeated' : ''}.`);
  });

  server.registerTool('remove_from_scene', {
    description: 'Creatures leave the scene (or are cleared away): a list of ids, or "all". Heroes are never affected.',
    inputSchema: { presence_ids: z.union([z.array(z.string()), z.literal('all')]), game_id: gameIdArg },
  }, (a) => {
    const id = h.resolve(a.game_id);
    const present = store.state(id).present;
    const ids = a.presence_ids === 'all' ? present.map((p) => p.id) : a.presence_ids.map((x) => findPresence(present, x).id);
    store.append(id, { type: 'presence_removed', presenceIds: ids });
    return text(ids.length ? `Removed ${ids.join(', ')}.` : 'Nobody to remove.');
  });

  server.registerTool('start_combat', {
    description: 'Start a fight. Asks each hero for an initiative roll and rolls secretly for each creature group. The turn order is set when every roll is in; you hear it through wait_for_players. Defaults: every hero still standing (or dying), every group with a live enemy or ally. Neutrals only when listed.',
    inputSchema: {
      hero_ids: z.array(z.string()).optional().describe('Character ids or names.'),
      presence_ids: z.array(z.string()).optional().describe('Creature ids; each brings its whole group.'),
      game_id: gameIdArg,
    },
  }, (a) => {
    const id = h.resolve(a.game_id);
    const s = store.state(id);
    if (s.combat) throw new Error('A fight is already on. Use add_to_combat for newcomers, or end_combat first.');
    const heroes = a.hero_ids
      ? [...new Set(a.hero_ids.map((x) => h.character(s, x).id))]
      : s.characters.filter((c) => c.status === 'up' || c.status === 'dying').map((c) => c.id);
    const groupIds = [...new Set(a.presence_ids
      ? a.presence_ids.map((x) => findPresence(s.present, x).groupId)
      : s.present.filter((p) => !p.defeated && p.side !== 'neutral').map((p) => p.groupId))];
    if (!heroes.length && !groupIds.length) throw new Error('Nobody to fight.');
    for (const e of planStartCombat(s, { heroes, groupIds }, d20)) store.append(id, e);
    const after = store.state(id);
    const groups = after.combat!.order.filter((e) => e.ref.kind === 'group');
    const asked = heroes.length ? ` Asked ${heroes.map((x) => h.character(after, x).name).join(', ')} for initiative.` : '';
    const rolled = groups.length ? ` ${groups.map((e) => `${entryName(after, e)} rolled ${e.initiative}`).join(', ')} (secret).` : '';
    const next = after.combat!.round === 0 ? ' The order is set when all rolls are in.' : ` Initiative order: ${orderText(after)}. ${roundText(after)}`;
    return text(`Fight!${asked}${rolled}${next}`);
  });

  server.registerTool('next_turn', {
    description: 'End the current turn and move to the next one who can act. Asks a dying hero for a death save on their turn.',
    inputSchema: { game_id: gameIdArg },
  }, (a) => {
    const id = h.resolve(a.game_id);
    const s = store.state(id);
    if (!s.combat) throw new Error('No fight is on. Use start_combat.');
    if (s.combat.round === 0) {
      const waiting = s.combat.order.filter((e) => e.initiative === null).map((e) => entryName(s, e));
      throw new Error(`Still gathering initiative: waiting on ${waiting.join(', ')}.`);
    }
    const events = planNextTurn(s);
    if (!events.length) return text('No one can act.');
    for (const e of events) store.append(id, e);
    return text(turnText(store.state(id)));
  });

  server.registerTool('add_to_combat', {
    description: 'Bring a newcomer into the fight at the given initiative total: a creature already in the scene (its whole group joins) or a hero.',
    inputSchema: {
      presence_id: z.string().optional(),
      character_id: z.string().optional(),
      initiative: z.number().int(),
      game_id: gameIdArg,
    },
  }, (a) => {
    const id = h.resolve(a.game_id);
    const s = store.state(id);
    if (!s.combat) throw new Error('No fight is on. Use start_combat.');
    if (!a.presence_id === !a.character_id) throw new Error('Give exactly one of presence_id or character_id.');
    const entry: CombatEntry = a.presence_id
      ? groupEntry(s, findPresence(s.present, a.presence_id).groupId, () => a.initiative)
      : heroEntry(s, h.character(s, a.character_id!).id, a.initiative);
    if (s.combat.order.some((e) => sameRef(e.ref, entry.ref))) throw new Error(`${entryName(s, entry)} is already in the fight.`);
    store.append(id, { type: 'combatant_added', entry });
    return text(`${entryName(s, entry)} joins the fight at initiative ${a.initiative}. Order: ${orderText(store.state(id))}.`);
  });

  server.registerTool('end_combat', {
    description: 'The fight is over. Clears the turn order; knocked-out heroes wake with 1 HP.',
    inputSchema: { game_id: gameIdArg },
  }, (a) => {
    const id = h.resolve(a.game_id);
    const s = store.state(id);
    if (!s.combat) throw new Error('No fight is on.');
    const out = s.characters.filter((c) => c.status === 'out').map((c) => c.name);
    store.append(id, { type: 'combat_ended' });
    for (const r of s.pendingRolls.filter((x) => x.purpose === 'initiative')) store.append(id, { type: 'roll_cancelled', rollId: r.rollId });
    return text(`The fight is over.${out.length ? ` ${out.join(', ')} ${out.length > 1 ? 'wake' : 'wakes'} with 1 HP.` : ''}`);
  });
}
