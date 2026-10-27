import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useResource } from '../src/resources.ts';
import { buildCharacter } from '../src/rules.ts';
import { mcpClient, mira, newStore, newTable } from './helpers.ts';

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
