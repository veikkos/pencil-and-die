import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHpChange } from '../src/life.ts';
import { mcpClient, mira, newStore, newTable } from './helpers.ts';

function table() {
  const store = newStore();
  const g = store.createGame('T');
  store.append(g.id, { type: 'character_created', character: mira() });
  const c = () => store.state(g.id).characters[0];
  const hurt = (hpDelta: number, critical?: boolean) => store.append(g.id, { type: 'character_updated', characterId: 'mira', patch: { hpDelta, critical } });
  let n = 0;
  const save = (face: number) => {
    const rollId = `ds${n++}`;
    store.append(g.id, { type: 'roll_requested', roll: { rollId, characterId: 'mira', label: 'Death save', dice: '1d20', modifier: 0, advantage: 'none', hideDc: true, purpose: 'death_save' } });
    store.append(g.id, { type: 'roll_resolved', rollId, faces: [face], total: face });
  };
  return { store, g, c, hurt, save };
}

test('life: dropping to 0 makes the hero dying and unconscious', () => {
  const { c, hurt } = table();
  hurt(-10);
  assert.equal(c().status, 'dying');
  assert.ok(c().conditions.includes('Unconscious'));
  assert.deepEqual(c().deathSaves, { successes: 0, failures: 0 });
});

test('life: death saves count successes and failures', () => {
  const { c, hurt, save } = table();
  hurt(-10);
  save(12);
  save(3);
  assert.deepEqual(c().deathSaves, { successes: 1, failures: 1 });
  save(1);
  assert.equal(c().deathSaves.failures, 3);
  assert.equal(c().status, 'dying');
});

test('life: three successes stabilise; damage destabilises', () => {
  const { c, hurt, save } = table();
  hurt(-10);
  save(10); save(15); save(19);
  assert.equal(c().status, 'stable');
  hurt(-2);
  assert.equal(c().status, 'dying');
  assert.equal(c().deathSaves.failures, 1);
});

test('life: natural 20 brings the hero back with 1 HP', () => {
  const { c, hurt, save } = table();
  hurt(-10);
  save(20);
  assert.equal(c().status, 'up');
  assert.equal(c().hp, 1);
  assert.ok(!c().conditions.includes('Unconscious'));
});

test('life: critical damage while dying is two failures', () => {
  const { c, hurt } = table();
  hurt(-10);
  hurt(-3, true);
  assert.equal(c().deathSaves.failures, 2);
  assert.equal(c().hp, 0);
});

test('life: healing while dying wakes the hero and clears saves', () => {
  const { c, hurt, save } = table();
  hurt(-10);
  save(3);
  hurt(4);
  assert.equal(c().status, 'up');
  assert.equal(c().hp, 4);
  assert.deepEqual(c().deathSaves, { successes: 0, failures: 0 });
});

test('life: the dead stay dead unless revived', () => {
  const dead = { ...mira(), status: 'dead' as const, hp: 0 };
  const raised = (hp: number, p: object) => applyHpChange(dead, { ...dead, hp }, p);
  const stays = raised(5, { hpDelta: 5 });
  assert.equal(stays.status, 'dead');
  assert.equal(stays.hp, 0);
  const revived = raised(5, { hpDelta: 5, revive: true });
  assert.equal(revived.status, 'up');
  assert.equal(revived.hp, 5);
});

test('life: a death save for a hero who is not dying changes nothing', () => {
  const { c, save } = table();
  const before = c();
  save(2);
  assert.deepEqual(c(), before);
});

test('life: a long rest brings a stable hero back up', () => {
  const { store, g, c, hurt, save } = table();
  hurt(-10);
  save(10); save(10); save(10);
  assert.equal(c().status, 'stable');
  store.append(g.id, { type: 'rest', kind: 'long', characterIds: ['mira'] });
  assert.equal(c().status, 'up');
  assert.equal(c().hp, c().maxHp);
  assert.ok(!c().conditions.includes('Unconscious'));
});

test('life: request_roll death save needs a dying hero and is built by the engine', async () => {
  const { store, db } = newTable();
  const g = store.createGame('T');
  store.append(g.id, { type: 'character_created', character: mira() });
  const mcp = await mcpClient(store, db);
  const bad = await mcp.call('request_roll', { character_id: 'mira', check: 'death save' });
  assert.ok(bad.isError);
  await mcp.call('update_character', { character_id: 'mira', hp_delta: -10 });
  const ok = await mcp.call('request_roll', { character_id: 'mira', check: 'Death save', dc: 15 });
  assert.ok(!ok.isError, ok.text);
  const roll = store.state(g.id).pendingRolls[0];
  assert.deepEqual([roll.label, roll.dice, roll.modifier, roll.dc, roll.purpose], ['Death save', '1d20', 0, undefined, 'death_save']);
});
