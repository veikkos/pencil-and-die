import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { findResource, useResource } from './resources.ts';
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
}
