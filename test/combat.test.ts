import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canAct, currentActor, planNextTurn, planStartCombat, sortOrder, type CombatEntry } from '../src/combat.ts';
import { newPresences } from '../src/roster.ts';
import { buildCharacter } from '../src/rules.ts';
import { playerView } from '../src/state.ts';
import { mcpClient, mira, newTable } from './helpers.ts';

const hero = (id: string, initiative: number | null, tiebreak: number): CombatEntry => ({ ref: { kind: 'hero', id }, initiative, tiebreak });
const group = (groupId: string, initiative: number, tiebreak: number): CombatEntry => ({ ref: { kind: 'group', groupId }, initiative, tiebreak });
const refs = (o: CombatEntry[]) => o.map((e) => (e.ref.kind === 'hero' ? e.ref.id : e.ref.groupId));
const torvald = () => buildCharacter('torvald', { name: 'Torvald', player: 'Ann', race: 'dwarf', className: 'fighter', preset: 'specialist' });

test('sortOrder: initiative, then DEX modifier / bonus, then heroes, then original order', () => {
  assert.deepEqual(refs(sortOrder([group('g', 15, 2), hero('mira', 15, 3)])), ['mira', 'g']);
  assert.deepEqual(refs(sortOrder([hero('mira', 15, 1), group('g', 15, 2)])), ['g', 'mira']);
  assert.deepEqual(refs(sortOrder([group('g', 15, 2), hero('mira', 15, 2)])), ['mira', 'g']);
  assert.deepEqual(refs(sortOrder([hero('a', 15, 2), hero('b', 15, 2)])), ['a', 'b']);
  assert.deepEqual(refs(sortOrder([hero('b', 15, 2), hero('a', 15, 2)])), ['b', 'a']);
  assert.deepEqual(refs(sortOrder([hero('a', 3, 0), group('g', 20, 0), hero('b', 9, 0)])), ['g', 'b', 'a']);
});

function fight() {
  const { store, db } = newTable();
  const g = store.createGame('T');
  store.append(g.id, { type: 'character_created', character: mira() });
  store.append(g.id, { type: 'character_created', character: torvald() });
  store.append(g.id, { type: 'presence_added', presences: newPresences([], { name: 'Goblin', side: 'enemy', hp: 7, initiativeBonus: 2 }, 2) });
  const state = () => store.state(g.id);
  const run = (events: ReturnType<typeof planNextTurn>) => events.map((e) => store.append(g.id, e));
  const start = () => run(planStartCombat(state(), { heroes: ['mira', 'torvald'], groupIds: ['goblin-1'] }, () => 12));
  const rollOf = (heroId: string) => state().pendingRolls.find((r) => r.characterId === heroId && r.purpose === 'initiative')!;
  const init = (heroId: string, total: number) => store.append(g.id, { type: 'roll_resolved', rollId: rollOf(heroId).rollId, faces: [total], total });
  const hurt = (id: string, hpDelta: number) => store.append(g.id, { type: 'character_updated', characterId: id, patch: { hpDelta } });
  const ordered = () => { start(); init('mira', 18); init('torvald', 5); };
  return { store, db, g, state, run, start, rollOf, init, hurt, ordered };
}

test('planStartCombat: secret creature initiative, an initiative roll per hero', () => {
  const { state } = fight();
  const events = planStartCombat(state(), { heroes: ['mira', 'torvald'], groupIds: ['goblin-1'] }, () => 12);
  assert.equal(events[0].type, 'combat_started');
  const started = events[0] as { order: CombatEntry[] };
  assert.deepEqual(started.order.map((e) => e.initiative), [null, null, 14]);
  assert.equal(started.order[0].tiebreak, 3);
  assert.equal(started.order[2].tiebreak, 2);
  const rolls = events.slice(1) as { type: 'roll_requested'; roll: any }[];
  assert.deepEqual(rolls.map((r) => [r.type, r.roll.characterId, r.roll.purpose, r.roll.dice, r.roll.label, r.roll.hideDc]),
    [['roll_requested', 'mira', 'initiative', '1d20', 'Initiative', true], ['roll_requested', 'torvald', 'initiative', '1d20', 'Initiative', true]]);
  assert.equal(rolls[0].roll.modifier, 3);
});

test('gathering: order is set when the last hero initiative is in', () => {
  const { state, start, init } = fight();
  start();
  assert.equal(state().combat!.round, 0);
  init('mira', 18);
  assert.equal(state().combat!.round, 0);
  init('torvald', 5);
  const c = state().combat!;
  assert.equal(c.round, 1);
  assert.deepEqual(refs(c.order), ['mira', 'goblin-1', 'torvald']);
  assert.deepEqual(c.order.map((e) => e.initiative), [18, 14, 5]);
  assert.deepEqual(currentActor(state())!.ref, { kind: 'hero', id: 'mira' });
  const line = state().log.at(-1)!;
  assert.equal(line.sys?.code, 'combatOrder');
  assert.deepEqual(line.sys?.params, { names: ['Mira', 'Goblin', 'Torvald'] });
});

test('all-creature fight starts straight away', () => {
  const { state, run } = fight();
  run(planStartCombat(state(), { heroes: [], groupIds: ['goblin-1'] }, () => 7));
  assert.equal(state().combat!.round, 1);
  assert.equal(state().combat!.turn, 0);
});

test('turn_advanced wraps to the next round and skips who cannot act', () => {
  const { store, g, state, run, ordered } = fight();
  ordered();
  run(planNextTurn(state()));
  run(planNextTurn(state()));
  assert.deepEqual(currentActor(state())!.ref, { kind: 'hero', id: 'torvald' });
  run(planNextTurn(state()));
  assert.equal(state().combat!.round, 2);
  assert.deepEqual(currentActor(state())!.ref, { kind: 'hero', id: 'mira' });
  for (const id of ['goblin-1', 'goblin-2']) store.append(g.id, { type: 'presence_updated', presenceId: id, patch: { defeated: true } });
  assert.equal(canAct(state(), state().combat!.order[1]), false);
  run(planNextTurn(state()));
  assert.deepEqual(currentActor(state())!.ref, { kind: 'hero', id: 'torvald' });
  store.append(g.id, { type: 'hero_fell', characterId: 'mira', outcome: 'knocked_out' });
  run(planNextTurn(state()));
  assert.equal(state().combat!.round, 3);
  assert.deepEqual(currentActor(state())!.ref, { kind: 'hero', id: 'torvald' });
});

test('planNextTurn asks a dying hero for a death save', () => {
  const { state, ordered, hurt } = fight();
  ordered();
  hurt('torvald', -100);
  assert.equal(state().characters[1].status, 'dying');
  const events = planNextTurn(state());
  assert.equal(events.length, 1);
  const s2 = planNextTurn({ ...state(), combat: { ...state().combat!, turn: 1 } });
  assert.deepEqual(s2.map((e) => e.type), ['turn_advanced', 'roll_requested']);
  const req = s2[1] as { type: 'roll_requested'; roll: any };
  assert.deepEqual([req.roll.characterId, req.roll.purpose, req.roll.dice, req.roll.modifier, req.roll.advantage, req.roll.hideDc, req.roll.label],
    ['torvald', 'death_save', '1d20', 0, 'none', true, 'Death save']);
});

test('cancelling an initiative roll during gathering starts the fight without that hero', () => {
  const { store, g, state, start, init, rollOf } = fight();
  start();
  init('mira', 18);
  store.append(g.id, { type: 'roll_cancelled', rollId: rollOf('torvald').rollId });
  const c = state().combat!;
  assert.equal(c.round, 1);
  assert.deepEqual(refs(c.order), ['mira', 'goblin-1']);
  assert.equal(state().pendingRolls.length, 0);
});

test('nobody can act: planNextTurn is empty and next_turn says so', async () => {
  const { store, db, g, state, ordered } = fight();
  ordered();
  for (const id of ['goblin-1', 'goblin-2']) store.append(g.id, { type: 'presence_updated', presenceId: id, patch: { defeated: true } });
  for (const id of ['mira', 'torvald']) store.append(g.id, { type: 'hero_fell', characterId: id, outcome: 'knocked_out' });
  assert.deepEqual(planNextTurn(state()), []);
  const c = await mcpClient(store, db);
  const r = await c.call('next_turn');
  assert.equal(r.text, 'No one can act.');
});

test('combatant_added mid-round keeps the current actor', () => {
  const { store, g, state, run, ordered } = fight();
  ordered();
  run(planNextTurn(state()));
  assert.deepEqual(currentActor(state())!.ref, { kind: 'group', groupId: 'goblin-1' });
  store.append(g.id, { type: 'presence_added', presences: newPresences(state().present, { name: 'Wolf', side: 'enemy' }, 1) });
  store.append(g.id, { type: 'combatant_added', entry: group('wolf', 20, 0) });
  assert.deepEqual(refs(state().combat!.order), ['wolf', 'mira', 'goblin-1', 'torvald']);
  assert.deepEqual(currentActor(state())!.ref, { kind: 'group', groupId: 'goblin-1' });
});

test('combat_ended clears the fight and wakes knocked-out heroes', () => {
  const { store, g, state, ordered } = fight();
  ordered();
  store.append(g.id, { type: 'hero_fell', characterId: 'mira', outcome: 'knocked_out' });
  assert.equal(state().characters[0].status, 'out');
  store.append(g.id, { type: 'combat_ended' });
  assert.equal(state().combat, null);
  assert.equal(state().characters[0].status, 'up');
  assert.equal(state().characters[0].hp, 1);
  assert.equal(state().log.at(-1)!.sys?.code, 'combatEnded');
});

test('playerView shows the order and turn, never initiative numbers', () => {
  const { state, start, init } = fight();
  start();
  init('mira', 18);
  const gathering = playerView(state()).combat!;
  assert.deepEqual(gathering.order.map((e) => e.ready), [true, false, true]);
  init('torvald', 5);
  const v = playerView(state()).combat!;
  assert.deepEqual(Object.keys(v).sort(), ['order', 'round', 'turn']);
  for (const e of v.order) assert.deepEqual(Object.keys(e).sort(), ['ready', 'ref']);
  assert.doesNotMatch(JSON.stringify(v), /14/);
});

test('rewind across combat start and gathering', () => {
  const { store, g, state, start, init } = fight();
  const before = state().seq;
  start();
  const gathered = state().seq;
  init('mira', 18);
  init('torvald', 5);
  store.rewind(g.id, gathered);
  assert.equal(state().combat!.round, 0);
  assert.equal(state().pendingRolls.filter((r) => r.purpose === 'initiative').length, 2);
  store.rewind(g.id, before);
  assert.equal(state().combat, null);
});

test('combat tools: start, next turn, newcomers, end', async () => {
  const { store, db, g, state, rollOf, init } = fight();
  const c = await mcpClient(store, db);
  const r = await c.call('start_combat');
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^Fight! Asked Mira, Torvald for initiative\. Goblin rolled \d+ \(secret\)\. The order is set when all rolls are in\.$/);
  assert.equal((await c.call('start_combat')).isError, true);
  assert.equal((await c.call('next_turn')).isError, true);
  store.append(g.id, { type: 'roll_resolved', rollId: rollOf('mira').rollId, faces: [20], total: 30 });
  init('torvald', 1);
  const wait = await c.call('wait_for_players', { timeout_seconds: 5 });
  assert.match(wait.text, /Initiative order: Mira 30, Goblin \d+, Torvald 1\. Round 1: Mira's turn\./);
  assert.equal((await c.call('next_turn')).text, "Round 1 — Goblin (goblin-1, goblin-2)'s turn: act for them, then call next_turn.");
  assert.equal((await c.call('next_turn')).text, "Round 1 — Torvald's turn.");
  const added = await c.call('add_to_scene', { name: 'Wolf', side: 'enemy', initiative: 40 });
  assert.equal(added.isError, false, added.text);
  assert.deepEqual(state().combat!.order[0].ref, { kind: 'group', groupId: 'wolf' });
  assert.deepEqual(currentActor(state())!.ref, { kind: 'hero', id: 'torvald' });
  assert.equal((await c.call('add_to_combat', { presence_id: 'wolf', initiative: 3 })).isError, true);
  store.append(g.id, { type: 'character_updated', characterId: 'mira', patch: { hpDelta: -100 } });
  assert.equal((await c.call('next_turn')).text, "Round 2 — Wolf's turn: act for them, then call next_turn.");
  assert.equal((await c.call('next_turn')).text, "Round 2 — Mira is dying: asked for Mira's death save.");
  assert.equal(state().pendingRolls.at(-1)!.purpose, 'death_save');
  const gs = JSON.parse((await c.call('get_game_state')).text);
  assert.equal(gs.combat.round, 2);
  const end = await c.call('end_combat');
  assert.equal(end.isError, false, end.text);
  assert.equal(state().combat, null);
});

test('add_to_combat slots in a hero who was not there', async () => {
  const { store, db, state, run } = fight();
  run(planStartCombat(state(), { heroes: [], groupIds: ['goblin-1'] }, () => 7));
  const c = await mcpClient(store, db);
  const r = await c.call('add_to_combat', { character_id: 'mira', initiative: 25 });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(refs(state().combat!.order), ['mira', 'goblin-1']);
  assert.deepEqual(currentActor(state())!.ref, { kind: 'group', groupId: 'goblin-1' });
});

test('end_combat during gathering withdraws pending initiative rolls', async () => {
  const { store, db, state, start } = fight();
  start();
  const c = await mcpClient(store, db);
  await c.call('end_combat');
  assert.equal(state().combat, null);
  assert.equal(state().pendingRolls.length, 0);
});
