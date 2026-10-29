// Plays a few scenes on a throwaway server and saves what the page would fetch, so stories show
// real engine output. Run with `npm run storybook:fixtures` after the engine or API changes.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = 4299;
const base = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'pencil-fixtures-'));
const out = fileURLToPath(new URL('./data.json', import.meta.url));

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(new URL('../../src/server.ts', import.meta.url))], {
  env: { ...process.env, PORT: String(PORT), DB_PATH: join(dir, 'game.db') },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise<void>((ok) => server.stdout!.on('data', (d) => { if (String(d).includes('D&D table')) ok(); }));

async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(`${path}: ${data.error}`);
  return data;
}

const client = new Client({ name: 'fixtures', version: '0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
async function dm(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  if (r.isError) throw new Error(`${name}: ${r.content[0]?.text}`);
  return r.content[0]?.text ?? '';
}

const pending = async (gameId: string) => (await api(`/api/games/${gameId}/state`)).pendingRolls as { rollId: string; characterId: string; purpose?: string }[];
const throwDice = (gameId: string, rollId: string, faces: number[]) => api(`/api/games/${gameId}/rolls/${rollId}`, { faces });
const say = (gameId: string, characterId: string, kind: string, text: string) => api(`/api/games/${gameId}/messages`, { characterId, kind, text });

const games: Record<string, any> = {};
const snapshot = async (name: string, gameId: string) => {
  games[name] = { id: gameId, state: await api(`/api/games/${gameId}/state`), history: await api(`/api/games/${gameId}/history`) };
};

// ---- A party still being put together ----------------------------------------

const setup = await api('/api/games', { title: 'The Sunken Bell' });
await api(`/api/games/${setup.id}/characters`, { name: 'Mira', player: 'Veikko', race: 'halfling', className: 'rogue', preset: 'specialist' });
await api(`/api/games/${setup.id}/characters`, { name: 'Torvald', player: 'Ann', race: 'dwarf', className: 'fighter', preset: 'sturdy' });
await snapshot('setup', setup.id);
await snapshot('setupEmpty', (await api('/api/games', { title: 'Fresh start' })).id);

// ---- The Drowned Lantern: exploring, a fight, a hero going down --------------

const g = await api('/api/games', { title: 'The Drowned Lantern' });
await api(`/api/games/${g.id}/open`, {});
const mira = await api(`/api/games/${g.id}/characters`, { name: 'Mira', player: 'Veikko', race: 'halfling', className: 'rogue', preset: 'specialist' });
const torvald = await api(`/api/games/${g.id}/characters`, { name: 'Torvald', player: 'Ann', race: 'dwarf', className: 'fighter', preset: 'sturdy' });
const elowen = await api(`/api/games/${g.id}/characters`, { name: 'Elowen', player: 'Sam', race: 'elf', className: 'wizard', preset: 'specialist' });
await api(`/api/games/${g.id}/start`, {});

await dm('set_scene', {
  title: 'The Drowned Lantern — taproom', description: 'A low-beamed harbour inn, half sunk into the mud.',
  present: [{ name: 'Old Brannock', side: 'neutral', description: 'The innkeeper. One eye, many opinions.' }],
});
await dm('draw_sketch', {
  caption: 'The taproom of the Drowned Lantern',
  svg: `<rect x="60" y="60" width="680" height="380"/>
    <line x1="60" y1="150" x2="740" y2="150"/><line x1="60" y1="300" x2="740" y2="300" stroke-dasharray="6 8"/>
    <rect x="120" y="180" width="160" height="50" rx="6"/><rect x="480" y="200" width="180" height="60" rx="6"/>
    <circle cx="200" cy="350" r="30"/><circle cx="560" cy="370" r="26"/>
    <path d="M600 60 L600 20 L650 20 L650 60"/><path d="M90 440 q30 -30 60 0 t60 0"/>
    <polyline points="680,90 700,110 680,130"/>
    <text x="130" y="210" font-family="Caveat" font-size="22" fill="#2b2b2b" stroke="none">bar</text>
    <text x="500" y="236" font-family="Caveat" font-size="22" fill="#2b2b2b" stroke="none">long table</text>
    <text x="610" y="50" font-family="Caveat" font-size="20" fill="#2b2b2b" stroke="none">stairs</text>`,
});
await dm('narrate', { text: 'Rain hammers the shutters of the Drowned Lantern. Old Brannock wipes the same mug for the third time, watching the door.\nSomewhere below the floorboards, water drips in a slow, patient rhythm.' });
await say(g.id, mira.id, 'action', 'I slide onto a stool at the bar and order whatever is warm.');
await say(g.id, torvald.id, 'speech', '"Who rings a bell under the sea, old man?"');
await dm('narrate', { text: 'Brannock stops wiping. "Nobody living," he says, and sets down a steaming bowl of fish stew in front of Mira.' });
await say(g.id, elowen.id, 'question', 'Can I tell if the dripping comes from a cellar?');
await dm('narrate', { kind: 'answer', character_id: elowen.id, text: 'You can try. Listen closely to where it comes from.' });
await dm('request_roll', { character_id: elowen.id, check: 'Perception', dc: 12 });
await throwDice(g.id, (await pending(g.id))[0].rollId, [14]);
await dm('narrate', { text: 'Beneath the long table, a trapdoor. The planks around it are wet and newer than the rest.' });
await dm('request_roll', { character_id: mira.id, check: 'Stealth', advantage: 'advantage' });
await snapshot('exploring', g.id);

await throwDice(g.id, (await pending(g.id))[0].rollId, [6, 17]);
await dm('narrate', { text: 'The trapdoor bursts open. Three goblins, dripping with harbour water, scramble up with knives drawn!' });
await dm('add_to_scene', { name: 'Goblin', side: 'enemy', hp: 7, ac: 13, initiative_bonus: 2, count: 3, description: 'Small, wet and furious.' });
await dm('start_combat', {});
await snapshot('initiative', g.id);

const faces: Record<string, number> = { [mira.id]: 18, [torvald.id]: 4, [elowen.id]: 11 };
for (const r of await pending(g.id)) await throwDice(g.id, r.rollId, [faces[r.characterId]]);
await dm('request_roll', { character_id: mira.id, attack: 'Dagger', target: 'goblin-1' });
await throwDice(g.id, (await pending(g.id))[0].rollId, [15]);
await dm('request_roll', { character_id: mira.id, damage: 'Dagger', target: 'goblin-1' });
await throwDice(g.id, (await pending(g.id))[0].rollId, [1]);
await dm('update_presence', { presence_id: 'goblin-2', hp_delta: -7, reason: 'magic missile' });
await dm('update_character', { character_id: torvald.id, hp_delta: -6, reason: 'goblin knife' });
await dm('update_character', { character_id: elowen.id, add_conditions: ['Frightened'], reason: 'a goblin shriek' });
await dm('update_character', { character_id: torvald.id, add_conditions: ['prone'], add_effects: [{ name: 'Blessed', note: '+1d4 to attacks and saves for a minute', concentration: elowen.id }], reason: 'knocked over; Elowen\'s blessing' });
await dm('use_resource', { character_id: elowen.id, resource: 'spell-slots-1' });
await dm('update_character', { character_id: mira.id, notes: 'Owes Brannock 3 silver.\nThe bell rings at low tide.' });
await dm('update_character', { character_id: mira.id, add_items: [{ name: 'Brass clapper', note: 'Pried from the drowned bell. Hums when the tide turns.' }] });
await dm('request_roll', { character_id: torvald.id, label: 'Battleaxe attack', modifier: 5, dc: 13 });
await snapshot('combat', g.id);

await throwDice(g.id, (await pending(g.id))[0].rollId, [3]);
await dm('update_character', { character_id: mira.id, hp_delta: -40, reason: 'goblin ambush' });
while (!(await pending(g.id)).some((r) => r.purpose === 'death_save')) await dm('next_turn');
await snapshot('dying', g.id);

// ---- Heroes levelling up: two choosing, two already at level 5 ------------------

const lv = await api('/api/games', { title: 'The Long Road' });
const lvl = (name: string, race: string, className: string, player: string) =>
  api(`/api/games/${lv.id}/characters`, { name, player, race, className, preset: 'specialist' });
const ela = await lvl('Elowen', 'elf', 'wizard', 'Sam');
const lark = await lvl('Lark', 'half-elf', 'bard', 'Veikko');
const tor = await lvl('Torvald', 'dwarf', 'fighter', 'Ann');
const ada = await lvl('Ada', 'human', 'cleric', 'Kim');
await api(`/api/games/${lv.id}/start`, {});
for (let i = 0; i < 2; i++) await dm('level_up', { character_id: ela.id, pick: 'recommended', game_id: lv.id });
await dm('level_up', { character_id: lark.id, pick: 'recommended', game_id: lv.id });
for (let i = 0; i < 4; i++) {
  await dm('level_up', { character_id: tor.id, game_id: lv.id, pick: 'recommended' });
  await dm('level_up', { character_id: ada.id, game_id: lv.id, pick: 'recommended' });
}
await dm('update_character', { character_id: ela.id, xp_delta: 2700, game_id: lv.id });
await dm('level_up', { character_id: ela.id, game_id: lv.id });
await dm('level_up', { character_id: lark.id, game_id: lv.id });
await snapshot('levelling', lv.id);

const config = await api('/api/config');
const rules = await api('/api/rules');
writeFileSync(out, `${JSON.stringify({ config: { ...config, activeGameId: null }, rules, games }, null, 1)}\n`);
console.log(`Wrote ${out}`);

await client.close();
server.kill();
rmSync(dir, { recursive: true, force: true });
