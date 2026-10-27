import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPresence, healthWord, newPresences, type Presence } from '../src/roster.ts';
import { playerView } from '../src/state.ts';
import { mcpClient, newTable } from './helpers.ts';

const mk = (hp: number | undefined, maxHp: number | undefined, defeated = false) => ({ hp, maxHp, defeated }) as Presence;

test('healthWord thresholds', () => {
  const words = [[10, 10], [6, 10], [5, 10], [3, 10], [2, 10], [0, 10]].map(([h, m]) => healthWord(mk(h, m)));
  assert.deepEqual(words, ['unhurt', 'hurt', 'bloodied', 'bloodied', 'nearDeath', 'defeated']);
  assert.equal(healthWord(mk(undefined, undefined)), undefined);
  assert.equal(healthWord(mk(undefined, undefined, true)), 'defeated');
});

test('newPresences ids and groups', () => {
  const two = newPresences([], { name: 'Goblin', side: 'enemy', hp: 7 }, 2);
  assert.deepEqual(two.map((p) => p.id), ['goblin-1', 'goblin-2']);
  assert.equal(two[0].groupId, two[1].groupId);
  assert.deepEqual(two.map((p) => p.name), ['Goblin', 'Goblin']);
  const one = newPresences(two, { name: 'Goblin', side: 'enemy' }, 1);
  assert.equal(one[0].id, 'goblin');
  const next = newPresences([...two, ...one], { name: 'Goblin', side: 'enemy' }, 1);
  assert.equal(next[0].id, 'goblin-3');
});

test('findPresence: ids, names and ambiguity', () => {
  const present = newPresences([], { name: 'Goblin', side: 'enemy', hp: 7 }, 2);
  assert.throws(() => findPresence(present, 'goblin'), /goblin-1, goblin-2/);
  assert.equal(findPresence(present, 'GOBLIN-2').id, 'goblin-2');
  const hurt = [{ ...present[0], defeated: true }, present[1]];
  assert.equal(findPresence(hurt, 'Goblin').id, 'goblin-2');
  assert.throws(() => findPresence(present, 'orc'), /goblin-1, goblin-2/);
});

function table() {
  const { store, db } = newTable();
  const g = store.createGame('T');
  return { store, db, g, state: () => store.state(g.id) };
}

test('update_presence to 0 HP defeats and logs player-safe line', async () => {
  const { store, db, g, state } = table();
  const c = await mcpClient(store, db);
  await c.call('add_to_scene', { name: 'Goblin', side: 'enemy', hp: 7, ac: 15, notes: 'carries the key', initiative_bonus: 2 });
  const r = await c.call('update_presence', { presence_id: 'goblin', hp_delta: -9 });
  assert.equal(r.isError, false);
  assert.equal(state().present[0].defeated, true);
  assert.equal(state().present[0].hp, 0);
  const last = state().log.at(-1)!;
  assert.equal(last.sys?.code, 'defeated');
  assert.doesNotMatch(last.text, /\d/);
  void g;
});

test('playerView hides creature secrets', async () => {
  const { store, db, state } = table();
  const c = await mcpClient(store, db);
  await c.call('add_to_scene', { name: 'Goblin', side: 'enemy', hp: 7, ac: 15, notes: 'SECRETKEY', initiative_bonus: 2, description: 'Snarling' });
  const v = playerView(state());
  assert.deepEqual(Object.keys(v.present[0]).sort(), ['conditions', 'defeated', 'description', 'groupId', 'health', 'id', 'name', 'side'].sort());
  const json = JSON.stringify(v);
  for (const k of ['"hp"', '"maxHp"', '"ac"', '"initiativeBonus"', '"notes"', 'SECRETKEY']) assert.ok(!json.includes(k), k);
  for (const l of state().log) if (l.sys) assert.doesNotMatch(l.text, /\d/);
});

test('scene_set replaces the roster only when present is given', async () => {
  const { store, db, g, state } = table();
  const c = await mcpClient(store, db);
  await c.call('add_to_scene', { name: 'Goblin', side: 'enemy', hp: 7, count: 2 });
  store.append(g.id, { type: 'scene_set', title: 'Next', description: '' });
  assert.equal(state().present.length, 2);
  const r = await c.call('set_scene', { title: 'Hall', description: '' });
  assert.match(r.text, /Still present: Goblin ×2/);
  store.append(g.id, { type: 'scene_set', title: 'Empty', description: '', present: [] });
  assert.equal(state().present.length, 0);
  const r2 = await c.call('set_scene', { title: 'Cave', present: [{ name: 'Bat', side: 'enemy', hp: 3, count: 2 }] });
  assert.doesNotMatch(r2.text, /Still present/);
  assert.deepEqual(state().present.map((p) => p.id), ['bat-1', 'bat-2']);
});

test('MCP: count, damage by id, remove all', async () => {
  const { store, db, state } = table();
  const c = await mcpClient(store, db);
  await c.call('add_to_scene', { name: 'Goblin', side: 'enemy', hp: 7, count: 2 });
  assert.deepEqual(state().present.map((p) => p.id), ['goblin-1', 'goblin-2']);
  assert.equal((await c.call('update_presence', { presence_id: 'goblin' , hp_delta: -1 })).isError, true);
  await c.call('update_presence', { presence_id: 'goblin-1', hp_delta: -7 });
  assert.equal(state().present[0].defeated, true);
  assert.equal(state().log.at(-1)!.sys?.code, 'defeated');
  await c.call('remove_from_scene', { presence_ids: 'all' });
  assert.deepEqual(state().present, []);
});

test('defeat follows HP only when it reaches or leaves 0', () => {
  const { store, g, state } = table();
  store.append(g.id, { type: 'presence_added', presences: newPresences([], { name: 'Goblin', side: 'enemy', hp: 7 }, 1) });
  store.append(g.id, { type: 'presence_updated', presenceId: 'goblin', patch: { defeated: true } });
  store.append(g.id, { type: 'presence_updated', presenceId: 'goblin', patch: { hpDelta: -2 } });
  assert.equal(state().present[0].defeated, true, 'a surrendered goblin stays defeated when hit');
  store.append(g.id, { type: 'presence_updated', presenceId: 'goblin', patch: { hpDelta: -10 } });
  assert.equal(state().present[0].hp, 0);
  store.append(g.id, { type: 'presence_updated', presenceId: 'goblin', patch: { hpDelta: 3 } });
  assert.equal(state().present[0].defeated, false, 'healed from 0 it is back');
  store.append(g.id, { type: 'presence_updated', presenceId: 'goblin', patch: { hpDelta: -3 } });
  assert.equal(state().present[0].defeated, true);
});

test('a creature without HP ignores hp_delta', () => {
  const { store, g, state } = table();
  store.append(g.id, { type: 'presence_added', presences: newPresences([], { name: 'Priest', side: 'neutral' }, 1) });
  store.append(g.id, { type: 'presence_updated', presenceId: 'priest', patch: { hpDelta: -3 } });
  assert.equal(state().present[0].hp, undefined);
  assert.equal(state().present[0].defeated, false);
  assert.equal(healthWord(state().present[0]), undefined);
});
