import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHpChange } from '../src/life.ts';
import { FALLEN_GUIDE, GameStore } from '../src/store.ts';
import { mcpClient, mira, newStore, newTable } from './helpers.ts';

function table() {
  const { store, db } = newTable();
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
  return { store, db, g, c, hurt, save };
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
  assert.equal(c().status, 'out');
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
  store.append(g.id, { type: 'roll_cancelled', rollId: roll.rollId });
  await mcp.call('request_roll', { character_id: 'mira', check: 'death save', advantage: 'advantage' });
  assert.equal(store.state(g.id).pendingRolls[0].advantage, 'none');
  const note = await mcp.call('update_character', { character_id: 'mira', notes: 'x' });
  assert.match(note.text, /on Mira's turn in combat/);
  assert.doesNotMatch(note.text, /\b(he|she|her|his)\b/i);
});

const lastEvent = (store: ReturnType<typeof newStore>, id: string) => store.liveEvents(id).at(-1)!;
const countFell = (store: ReturnType<typeof newStore>, id: string) => store.liveEvents(id).filter((e) => e.event.type === 'hero_fell').length;

test('fallen: by default three failed saves knock the hero out', () => {
  const { store, g, c, hurt, save } = table();
  assert.equal(store.fallenHeroes(), 'knockout');
  hurt(-10);
  const cursor = store.dmCursor(g.id);
  save(2); save(2); save(2);
  assert.equal(c().status, 'out');
  assert.equal(c().hp, 0);
  const fell = lastEvent(store, g.id).event;
  assert.deepEqual(fell, { type: 'hero_fell', characterId: 'mira', outcome: 'knocked_out' });
  assert.ok(store.unseenPlayerEvents(g.id).some((e) => e.event.type === 'hero_fell'));
  assert.ok(store.liveEvents(g.id, cursor).some((e) => e.event.type === 'hero_fell'));
  assert.ok(store.state(g.id).log.some((l) => l.sys?.code === 'fell'));
});

test('fallen: in death mode the hero dies, and the recorded outcome survives a setting change and replay', () => {
  const { store, db, g, c, hurt, save } = table();
  store.setFallenHeroes('death');
  hurt(-10);
  save(2); save(2); save(2);
  assert.equal(c().status, 'dead');
  store.setFallenHeroes('knockout');
  const latest = store.state(g.id).seq;
  assert.equal(store.stateAt(g.id, latest).characters[0].status, 'dead');
  assert.equal(new GameStore(db).stateAt(g.id, latest).characters[0].status, 'dead');
});

test('fallen: rewinding before the third failure and changing the setting records the new outcome once', () => {
  const { store, g, c, hurt, save } = table();
  store.setFallenHeroes('death');
  hurt(-10);
  save(2); save(2);
  const before = store.state(g.id).seq;
  save(2);
  assert.equal(c().status, 'dead');
  store.rewind(g.id, before + 1);
  assert.equal(store.state(g.id).pendingRolls.length, 1);
  store.setFallenHeroes('knockout');
  store.append(g.id, { type: 'roll_resolved', rollId: store.state(g.id).pendingRolls[0].rollId, faces: [2], total: 2 });
  assert.equal(countFell(store, g.id), 1);
  assert.equal((lastEvent(store, g.id).event as { outcome: string }).outcome, 'knocked_out');
  assert.equal(c().status, 'out');
});

test('fallen: the setting validates, defaults and notifies the DM', () => {
  const { store, g } = table();
  assert.throws(() => store.setFallenHeroes('x' as never));
  assert.equal(store.fallenHeroes(), 'knockout');
  store.setFallenHeroes('death');
  assert.equal(store.fallenHeroes(), 'death');
  assert.ok(store.pendingNotices(g.id).some((n) => n === FALLEN_GUIDE.death));
});

test('fallen: healing a knocked-out hero brings them back up', () => {
  const { c, hurt, save } = table();
  hurt(-10);
  save(2); save(2); save(2);
  assert.equal(c().status, 'out');
  hurt(3);
  assert.equal(c().status, 'up');
  assert.equal(c().hp, 3);
});

test('fallen: the dead stay dead when healed, and revive brings them back', () => {
  const { store, g, c, hurt, save } = table();
  store.setFallenHeroes('death');
  hurt(-10);
  save(2); save(2); save(2);
  hurt(5);
  assert.equal(c().status, 'dead');
  assert.equal(c().hp, 0);
  store.append(g.id, { type: 'character_updated', characterId: 'mira', patch: { hpDelta: 5, revive: true } });
  assert.equal(c().status, 'up');
  assert.equal(c().hp, 5);
});
