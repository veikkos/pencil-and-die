import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { findResource, useResource } from './resources.ts';
import { findPresence, newPresences, presenceSpec, type PresencePatch } from './roster.ts';
import type { Character } from './rules.ts';
import type { GameState } from './state.ts';
import type { GameStore } from './store.ts';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const gameIdArg = z.string().optional().describe('Game id. Defaults to the game currently open on the table.');

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
    return text(`Added ${made.map((p) => p.id).join(', ')}.`);
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
}
