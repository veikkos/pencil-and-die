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

test('extra-damage features roll on their own and apply to the target', async () => {
  const { store, g, c, state } = await goblinFight();
  const asked = await c.call('request_roll', { character_id: 'Mira', damage: 'Sneak Attack', target: 'goblin-1' });
  assert.match(asked.text, /Sneak Attack damage against goblin-1: 1d6 \+0/);
  throwDice(store, g.id, [5]);
  assert.equal(state().present[0].hp, 2);
  const crit = await c.call('request_roll', { character_id: 'Mira', damage: 'sneak attack', critical: true });
  assert.match(crit.text, /2d6/);
  // Only heroes with the feature have it.
  store.append(g.id, { type: 'character_created', character: { ...mira(), id: 'tor', name: 'Tor', features: [] } });
  assert.equal((await c.call('request_roll', { character_id: 'Tor', damage: 'Sneak Attack' })).isError, true);
});

test('dm_roll: a monster attack on a hero is checked against their AC; its damage comes off their HP', async () => {
  const { c, state } = await goblinFight();
  const attack = await c.call('dm_roll', { label: 'Goblin scimitar', modifier: 4, target: 'Mira' });
  assert.match(attack.text, /vs Mira AC 14 → (CRITICAL HIT|HIT|MISS|natural 1, a MISS)/);
  const roll = state().rolls.at(-1)!;
  assert.equal(roll.dc, 14);
  assert.equal(roll.targetId, 'mira');
  assert.equal(state().log.at(-1)!.sys?.params.hit, roll.success);

  const dmg = await c.call('dm_roll', { label: 'Goblin scimitar damage', dice: '1d6', modifier: 2, target: 'Mira', damage: true });
  const dealt = state().rolls.at(-1)!.total;
  assert.equal(state().characters[0].hp, 10 - dealt);
  assert.match(dmg.text, new RegExp(`${dealt} damage to Mira: HP ${10 - dealt}/10`));

  await c.call('dm_roll', { label: 'Big hit', dice: '1d4', modifier: 20, target: 'Mira', damage: true, critical: true });
  assert.equal(state().rolls.at(-1)!.dice, '2d4');
  assert.equal(state().characters[0].status, 'dying');
});

test('dm_roll: damage can go to a creature too, and the target checks guard misuse', async () => {
  const { c, state } = await goblinFight();
  await c.call('dm_roll', { label: 'Falling rock', dice: '1d4', modifier: 10, target: 'goblin-2', damage: true });
  assert.equal(state().present[1].defeated, true);
  const bad = async (args: Record<string, unknown>, why: RegExp) => {
    const r = await c.call('dm_roll', { label: 'x', ...args });
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.text, why);
  };
  await bad({ damage: true }, /go with a `target`/);
  await bad({ target: 'Mira', dc: 12 }, /leave out `dc`/);
  await bad({ target: 'Mira', dice: '2d6' }, /one d20/);
  await bad({ target: 'goblin-2', damage: true, dice: '1d6' }, /already defeated/);
});
