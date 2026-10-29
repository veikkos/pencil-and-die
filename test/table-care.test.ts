import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meetsDc, parseDice, scoreRoll } from '../src/dice.ts';
import { slug } from '../src/roster.ts';
import { sheetOf } from '../src/sheet.ts';
import { buildCharacter } from '../src/rules.ts';
import type { GameStore } from '../src/store.ts';
import { mcpClient, mira, newTable } from './helpers.ts';

const halla = () => buildCharacter('halla', { name: 'Halla', player: 'Sanni', race: 'dwarf', className: 'cleric', preset: 'specialist' });

/** What the page does when a player types in their dice: the oldest roll for `who`. */
function throwDice(store: GameStore, gameId: string, who: string, faces: number[]) {
  const roll = store.state(gameId).pendingRolls.find((r) => r.characterId === who)!;
  const out = scoreRoll(parseDice(roll.dice), roll.advantage, roll.modifier, faces);
  store.append(gameId, { type: 'roll_resolved', rollId: roll.rollId, faces: out.faces, total: out.total, success: meetsDc(roll, out.faces, out.total) });
}

async function party() {
  const { store, db } = newTable();
  const g = store.createGame('T');
  store.append(g.id, { type: 'character_created', character: halla() });
  store.append(g.id, { type: 'character_created', character: mira() });
  const c = await mcpClient(store, db);
  const hero = (id: string) => store.state(g.id).characters.find((x) => x.id === id)!;
  return { store, g, c, hero, state: () => store.state(g.id) };
}

test('slug: Finnish letters keep their base form', () => {
  assert.equal(slug('Jättisammakko'), 'jattisammakko');
  assert.equal(slug('Öljyinen örkki'), 'oljyinen-orkki');
  assert.equal(slug('!!!'), 'creature');
});

test('stabilize: a dying hero stops dying, stays down at 0 HP, and healing still wakes them', async () => {
  const { c, hero } = await party();
  await c.call('update_character', { character_id: 'Mira', hp_delta: -10 });
  assert.equal(hero('mira').status, 'dying');
  const r = await c.call('update_character', { character_id: 'Mira', stabilize: true, reason: 'Medicine' });
  assert.match(r.text, /stable at 0 HP/);
  assert.equal(hero('mira').hp, 0);
  assert.ok(hero('mira').conditions.includes('Unconscious'));
  await c.call('update_character', { character_id: 'Mira', hp_delta: 3 });
  assert.equal(hero('mira').status, 'up');
});

test('concentration: damage asks for a save; failing it ends the effect on everyone', async () => {
  const { store, g, c, hero, state } = await party();
  for (const who of ['Halla', 'Mira']) {
    await c.call('update_character', { character_id: who, add_effects: [{ name: 'Blessed', note: '+1d4', concentration: 'Halla' }] });
  }
  assert.equal(hero('mira').effects[0].by, 'halla');
  // Damage to someone else asks nothing.
  await c.call('update_character', { character_id: 'Mira', hp_delta: -2 });
  assert.equal(state().pendingRolls.length, 0);

  // Temp HP soak a big hit; half of it is the save's DC.
  await c.call('update_character', { character_id: 'Halla', temp_hp: 30 });
  await c.call('update_character', { character_id: 'Halla', hp_delta: -22 });
  const save = state().pendingRolls[0];
  assert.equal(save.purpose, 'concentration');
  assert.equal(save.dc, 11);
  assert.equal(save.modifier, 3); // CON 16; clerics are proficient in WIS and CHA saves, not CON
  throwDice(store, g.id, 'halla', [2]);
  assert.deepEqual([hero('halla').effects, hero('mira').effects], [[], []]);
  assert.equal(state().log.at(-1)!.sys?.code, 'concentrationLost');
  const wait = await c.call('wait_for_players', { timeout_seconds: 5 });
  assert.match(wait.text, /CONCENTRATION Halla: .* vs DC 11 → Halla loses concentration/);
});

test('concentration: holds on a good save, ends when the caster falls or starts another spell', async () => {
  const { store, g, c, hero, state } = await party();
  await c.call('update_character', { character_id: 'Mira', add_effects: [{ name: 'Blessed', note: '+1d4', concentration: 'Halla' }] });
  await c.call('update_character', { character_id: 'Halla', hp_delta: -1 });
  throwDice(store, g.id, 'halla', [15]);
  assert.equal(hero('mira').effects.length, 1);

  await c.call('update_character', { character_id: 'Mira', add_effects: [{ name: 'Shield of Faith', note: '+2 AC', concentration: 'Halla' }] });
  assert.deepEqual(hero('mira').effects.map((x) => x.name), ['Shield of Faith']);

  // A save still owed when the caster drops goes away with the spell.
  await c.call('update_character', { character_id: 'Halla', hp_delta: -1 });
  assert.equal(state().pendingRolls.length, 1);
  await c.call('update_character', { character_id: 'Halla', hp_delta: -30 });
  assert.equal(hero('halla').status, 'dying');
  assert.deepEqual(hero('mira').effects, []);
  assert.ok(!state().pendingRolls.some((r) => r.purpose === 'concentration'));
});

test('hit dice: a short rest asks for them and the healing applies itself', async () => {
  const { store, g, c, hero, state } = await party();
  await c.call('update_character', { character_id: 'Halla', hp_delta: -8 });
  const r = await c.call('rest', { kind: 'short', hit_dice: ['Halla'] });
  assert.match(r.text, /Asked to roll hit dice: Halla/);
  const roll = state().pendingRolls[0];
  assert.deepEqual([roll.purpose, roll.dice, roll.modifier], ['hit_die', '1d8', 3]);
  throwDice(store, g.id, 'halla', [4]);
  assert.equal(hero('halla').hp, 12 - 8 + 7);
  assert.equal(hero('halla').resources.find((x) => x.id === 'hit-dice')!.used, 1);

  const none = await c.call('rest', { kind: 'short', hit_dice: ['Halla'] });
  assert.equal(none.isError, true);
  assert.match(none.text, /no hit dice left/);
  assert.equal((await c.call('request_roll', { character_id: 'Halla', check: 'hit die' })).isError, true);
  assert.match((await c.call('rest', { kind: 'short' })).text, /Hit dice left: Halla 0, Mira 1/);
});

test('named rolls carry what they are, so the page can name them in its language', async () => {
  const { store, g, c, state } = await party();
  await c.call('request_roll', { character_id: 'Mira', damage: 'Sneak Attack' });
  assert.deepEqual(state().pendingRolls[0].action, { kind: 'damage', of: 'feature', id: 'Sneak Attack', name: 'Sneak Attack' });
  throwDice(store, g.id, 'mira', [3]);
  assert.equal((state().log.at(-1)!.sys?.params.action as { name: string }).name, 'Sneak Attack');
  await c.call('request_roll', { character_id: 'Halla', attack: 'Mace', label: 'Big swing' });
  assert.equal(state().pendingRolls[0].action, undefined);
});

const gorm = () => buildCharacter('gorm', { name: 'Gorm', player: 'Pete', race: 'half-orc', className: 'barbarian', preset: 'specialist' });

test('area damage: everyone it hits takes their share, heroes and creatures alike', async () => {
  const { store, g, c, hero, state } = await party();
  await c.call('add_to_scene', { name: 'Goblin', side: 'enemy', hp: 7, ac: 15 });
  await c.call('add_to_scene', { name: 'Murkku', side: 'enemy', hp: 20, ac: 16 });
  const asked = await c.call('request_roll', { character_id: 'Halla', damage: 'Sacred Flame', targets: ['goblin', { who: 'murkku', takes: 'half' }, { who: 'Mira', takes: 'none' }] });
  assert.match(asked.text, /against goblin, murkku \(half\), mira \(none\)/);
  throwDice(store, g.id, 'halla', [7]);
  assert.deepEqual(state().present.map((p) => p.hp), [0, 17]);
  assert.equal(hero('mira').hp, 10);
  const wait = await c.call('wait_for_players', { timeout_seconds: 5 });
  assert.match(wait.text, /7 to goblin \(0\/7 HP, DEFEATED\); 3 to murkku, half \(17\/20 HP\); 0 to Mira, none/);
  assert.equal((await c.call('request_roll', { character_id: 'Halla', attack: 'Mace', targets: ['goblin'] })).isError, true);
});

test('effects carry numbers: Rage adds melee damage, resists slashing and ends with the fight', async () => {
  const { store, db } = newTable();
  const g = store.createGame('T');
  store.append(g.id, { type: 'character_created', character: gorm() });
  const c = await mcpClient(store, db);
  const me = () => store.state(g.id).characters[0];
  const axe = () => sheetOf(me()).attacks.find((a) => a.name === 'Greataxe')!;
  const before = axe().bonus;
  await c.call('add_to_scene', { name: 'Goblin', side: 'enemy', hp: 7, ac: 15, initiative_bonus: 2 });
  await c.call('start_combat', {});
  const used = await c.call('use_resource', { character_id: 'Gorm', resource: 'rage' });
  assert.match(used.text, /Rage/);
  assert.equal(me().effects[0].name, 'Rage');
  assert.equal(axe().bonus, before + 2);
  const hit = await c.call('dm_roll', { label: 'Scimitar', dice: '1d4', modifier: 10, target: 'Gorm', damage: true, damage_type: 'slashing' });
  const total = store.state(g.id).rolls.at(-1)!.total;
  assert.match(hit.text, new RegExp(`${Math.floor(total / 2)} to Gorm, half`));
  await c.call('end_combat', {});
  assert.deepEqual(me().effects, []);
});

test('effects carry numbers: Mage Armor and Shield of Faith change the AC monsters aim at', async () => {
  const { c, hero } = await party();
  await c.call('update_character', { character_id: 'Mira', add_effects: [{ name: 'Shield of Faith', note: '+2', concentration: 'Halla' }] });
  assert.equal(sheetOf(hero('mira')).ac, 16);
  const swing = await c.call('dm_roll', { label: 'Club', modifier: 0, target: 'Mira' });
  assert.match(swing.text, /vs Mira AC 16/);
  await c.call('update_character', { character_id: 'Mira', add_effects: [{ name: 'Taikahaarniska', note: '13 + DEX' }] });
  assert.equal(sheetOf(hero('mira')).ac, 13 + 3 + 2);
  await c.call('update_character', { character_id: 'Mira', add_effects: [{ name: 'Lucky charm', note: 'feels nice', ac_bonus: 1 }] });
  assert.equal(sheetOf(hero('mira')).ac, 19);
});
