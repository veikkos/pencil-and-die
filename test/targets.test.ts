import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meetsDc, parseDice, scoreRoll } from '../src/dice.ts';
import type { GameStore } from '../src/store.ts';
import { mcpClient, mira, newTable } from './helpers.ts';

/** What the page does when a player types in their dice. */
function throwDice(store: GameStore, gameId: string, faces: number[]) {
  const roll = store.state(gameId).pendingRolls.at(-1)!;
  const out = scoreRoll(parseDice(roll.dice), roll.advantage, roll.modifier, faces);
  store.append(gameId, { type: 'roll_resolved', rollId: roll.rollId, faces: out.faces, total: out.total, success: meetsDc(roll, out.faces, out.total) });
}

async function goblinFight() {
  const { store, db } = newTable();
  const g = store.createGame('T');
  store.append(g.id, { type: 'character_created', character: mira() });
  const c = await mcpClient(store, db);
  await c.call('add_to_scene', { name: 'Goblin', side: 'enemy', hp: 7, ac: 15, count: 2 });
  return { store, g, c, state: () => store.state(g.id) };
}

test('meetsDc: an attack hits on its critical range and misses on a natural 1', () => {
  const attack = { dc: 15, critOn: 19, advantage: 'none' as const };
  assert.equal(meetsDc(attack, [19], 24), true);
  assert.equal(meetsDc(attack, [19], 10), true);
  assert.equal(meetsDc(attack, [1], 30), false);
  assert.equal(meetsDc(attack, [10], 15), true);
  assert.equal(meetsDc({ ...attack, advantage: 'advantage' }, [1, 19], 2), true);
  // Checks have no criticals.
  assert.equal(meetsDc({ dc: 15, advantage: 'none' }, [20], 14), false);
  assert.equal(meetsDc({ advantage: 'none' }, [20], 14), undefined);
});

test('a targeted attack is checked against the AC and shows only hit or miss', async () => {
  const { store, g, c, state } = await goblinFight();
  const asked = await c.call('request_roll', { character_id: 'Mira', attack: 'Rapier', target: 'goblin-2' });
  assert.match(asked.text, /against goblin-2/);
  assert.equal(state().pendingRolls[0].dc, 15);
  assert.equal(state().pendingRolls[0].hideDc, true);
  throwDice(store, g.id, [12]);
  const line = state().log.at(-1)!;
  assert.equal(line.sys?.params.hit, true);
  assert.equal(line.sys?.params.success, undefined);
  assert.match(line.text, /— hit$/);
  const wait = await c.call('wait_for_players', { timeout_seconds: 5 });
  assert.match(wait.text, /vs goblin-2 AC 15 → HIT: request_roll damage with target "goblin-2"/);
});

test('targeted damage comes off the creature and can defeat it, and a rewind gives it back', async () => {
  const { store, g, c, state } = await goblinFight();
  await c.call('request_roll', { character_id: 'Mira', damage: 'Rapier', target: 'goblin-1' });
  const before = state().seq;
  throwDice(store, g.id, [2]);
  assert.equal(state().present[0].hp, 2);
  assert.equal(state().log.at(-1)!.sys?.code, 'presenceUpdated');
  const wait = await c.call('wait_for_players', { timeout_seconds: 5 });
  assert.match(wait.text, /5 damage applied to goblin-1: 2\/7 HP/);

  await c.call('request_roll', { character_id: 'Mira', damage: 'Rapier', target: 'goblin-1' });
  throwDice(store, g.id, [8]);
  assert.equal(state().present[0].defeated, true);
  assert.equal(state().log.at(-1)!.sys?.code, 'defeated');

  store.rewind(g.id, before);
  assert.equal(state().present[0].hp, 7);
});

test('request_roll refuses targets it cannot apply', async () => {
  const { c } = await goblinFight();
  await c.call('add_to_scene', { name: 'Shopkeeper', side: 'neutral' });
  const bad = async (args: Record<string, unknown>, why: RegExp) => {
    const r = await c.call('request_roll', { character_id: 'Mira', ...args });
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.text, why);
  };
  await bad({ check: 'Stealth', target: 'goblin-1' }, /goes with `attack` or `damage`/);
  await bad({ attack: 'Rapier', target: 'shopkeeper' }, /no AC/);
  await bad({ damage: 'Rapier', target: 'shopkeeper' }, /no HP/);
  await bad({ attack: 'Rapier', target: 'goblin-1', dc: 12 }, /leave out `dc`/);
  await bad({ attack: 'Rapier', target: 'orc' }, /No creature "orc"/);
});

test('DM notes can be rewritten and retired', async () => {
  const { store, db } = newTable();
  const g = store.createGame('T');
  const c = await mcpClient(store, db);
  const added = await c.call('add_dm_note', { text: 'Nirpo the kobold has 5 HP' });
  const note = Number(/note (\d+)/.exec(added.text)![1]);
  await c.call('add_dm_note', { text: 'The well is cursed' });

  await c.call('edit_dm_note', { note, text: 'Nirpo surrendered and guides the party' });
  assert.deepEqual(store.state(g.id).dmNotes.map((n) => n.text), ['Nirpo surrendered and guides the party', 'The well is cursed']);

  await c.call('edit_dm_note', { note, retire: true });
  assert.deepEqual(store.state(g.id).dmNotes.map((n) => n.text), ['The well is cursed']);

  assert.equal((await c.call('edit_dm_note', { note })).isError, true);
  assert.match((await c.call('edit_dm_note', { note: 999, retire: true })).text, /No note 999/);
});
