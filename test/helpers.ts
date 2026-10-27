import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDb, type Db } from '../src/db.ts';
import { createMcpServer } from '../src/mcp.ts';
import { buildCharacter } from '../src/rules.ts';
import { GameStore } from '../src/store.ts';

export const newStore = () => new GameStore(openDb(':memory:'));
export const newTable = (): { store: GameStore; db: Db } => {
  const db = openDb(':memory:');
  return { store: new GameStore(db), db };
};
export const mira = () => buildCharacter('mira', { name: 'Mira', player: 'Veikko', race: 'halfling', className: 'rogue', preset: 'specialist' });

export async function mcpClient(store: GameStore, db: Db) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(store, db).connect(b);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(a);
  return {
    async call(name: string, args: Record<string, unknown> = {}) {
      const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
      return { text: r.content.find((c) => c.type === 'text')?.text ?? '', isError: !!r.isError };
    },
    async listTools() {
      return (await client.listTools()).tools.map((t) => t.name);
    },
  };
}
