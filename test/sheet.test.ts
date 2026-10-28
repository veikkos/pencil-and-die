import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCharacter, CLASSES, RACES, type Character } from '../src/rules.ts';
import { attackRoll, damageRoll, sheetOf } from '../src/sheet.ts';
import { playerView } from '../src/state.ts';
import { weaponFor } from '../src/weapons.ts';
import { mcpClient, mira, newStore, newTable } from './helpers.ts';

const hero = (race: string, className: string) => buildCharacter(className, { name: className, player: '', race, className, preset: 'specialist' });

test('sheet: rogue weapons, ammo, skills and saves', () => {
  const m = mira(); // halfling rogue: DEX 17 (+3), STR 8 (−1)
  const s = sheetOf(m);
  const by = (n: string) => s.attacks.find((a) => a.name === n)!;
  assert.deepEqual(s.attacks.map((a) => a.name), ['Rapier', 'Shortbow', 'Dagger', 'Unarmed strike']);
  assert.equal(by('Rapier').toHit, 5);
  assert.equal(by('Rapier').damage, '1d8+3');
  assert.equal(by('Shortbow').ammo, 20);
  assert.equal(by('Shortbow').range, '80/320');
  assert.equal(by('Dagger').count, 2);
  assert.deepEqual(by('Dagger').properties, ['finesse', 'light', 'thrown (20/60)']);
  assert.equal(by('Unarmed strike').damage, '1'); // 1 + STR −1, never below 1
  assert.equal(s.skills.length, 18);
  // Expertise: proficiency counts twice for the rogue's Stealth.
  const stealth = s.skills.find((k) => k.name === 'Stealth')!;
  assert.equal(stealth.mod, 7);
  assert.equal(stealth.expertise, true);
  assert.deepEqual(stealth.parts, [{ from: 'ability', ability: 'dex', value: 3 }, { from: 'proficiency', value: 2 }, { from: 'expertise', value: 2 }]);
  assert.equal(s.skills.find((k) => k.name === 'Acrobatics')!.mod, 5);
  assert.equal(s.skills.find((k) => k.name === 'Athletics')!.mod, -1);
  assert.equal(s.initiative, 3);
  assert.equal(s.passivePerception, 10 + s.skills.find((k) => k.name === 'Perception')!.mod);
  assert.equal(s.saves.find((x) => x.ability === 'dex')!.mod, 5);
  assert.equal(s.saves.find((x) => x.ability === 'dex')!.proficient, true);
  assert.equal(s.spellcasting, undefined);
  assert.deepEqual(s.spells, []);
  assert.equal(s.inventory.find((i) => i.name === 'Leather armour')!.kind, 'armour');
  assert.equal(s.inventory.find((i) => i.name === 'Arrows')!.kind, 'ammo');
});

test('sheet: wizard spells with DC, to-hit, slots', () => {
  const s = sheetOf(hero('elf', 'wizard')); // INT 15 + 1 = 16 (+3)
  const { ability, attack, saveDc, slots } = s.spellcasting!;
  assert.deepEqual({ ability, attack, saveDc, slots }, { ability: 'int', attack: 5, saveDc: 13, slots: { 1: 'spell-slots-1' } });
  const sp = (n: string) => s.spells.find((x) => x.name === n)!;
  assert.equal(sp('Fire Bolt').toHit, 5);
  assert.equal(sp('Fire Bolt').roll, '1d10');
  assert.equal(sp('Fire Bolt').resourceId, undefined);
  assert.equal(sp('Burning Hands').saveDc, 13);
  assert.equal(sp('Burning Hands').resourceId, 'spell-slots-1');
  assert.equal(sp('Magic Missile').roll, '1d4+1 ×3');
  assert.equal(s.features.find((f) => f.name === 'Arcane Recovery')!.resourceId, 'arcane-recovery');
});

test('sheet: warlock spends the pact slot, cleric heals with WIS, tiefling knows Thaumaturgy', () => {
  assert.equal(sheetOf(hero('human', 'warlock')).spells.find((x) => x.name === 'Hex')!.resourceId, 'pact-slot');
  const cleric = hero('dwarf', 'cleric'); // WIS 15 + 1 = 16 (+3)
  assert.equal(sheetOf(cleric).spells.find((x) => x.name === 'Cure Wounds')!.roll, '1d8+3');
  const tief = hero('tiefling', 'fighter');
  assert.deepEqual(tief.spells.map((x) => x.name), ['Thaumaturgy']);
  assert.equal(sheetOf(tief).spellcasting!.ability, 'cha');
});

test('sheet: monks fight with DEX and a martial-arts die', () => {
  const s = sheetOf(hero('human', 'monk')); // DEX 16 (+3), STR 13 (+1)
  const unarmed = s.attacks.find((a) => a.name === 'Unarmed strike')!;
  assert.equal(unarmed.damage, '1d4+3');
  assert.equal(s.attacks.find((a) => a.name === 'Shortsword')!.ability, 'dex');
  assert.equal(s.attacks.find((a) => a.name === 'Dart')!.count, 10);
});

test('every class and race builds and gets a sheet', () => {
  for (const r of RACES) for (const c of CLASSES) {
    const s = sheetOf(hero(r.id, c.id));
    assert.ok(s.attacks.length >= 2, `${r.id} ${c.id}`);
    for (const f of s.features) if (f.resourceId) assert.ok(hero(r.id, c.id).resources.some((x) => x.id === f.resourceId), `${c.id}: ${f.name}`);
  }
});

test('old characters (string features, bundled items) replay into the same sheet', () => {
  const store = newStore();
  const g = store.createGame('T');
  const old = {
    ...hero('half-elf', 'sorcerer'),
    inventory: [{ name: 'Light crossbow + 20 bolts', qty: 1 }, { name: '2 Daggers', qty: 1 }, { name: 'Arcane focus', qty: 1 }],
    features: ['Darkvision 60 ft', 'Fey Ancestry', '+1 to two other abilities', 'Two extra skills',
      'Spellcasting (CHA): cantrips Fire Bolt, Prestidigitation, Ray of Frost, Light; spells Magic Missile, Chromatic Orb; 2 first-level slots',
      'Draconic Bloodline (+1 HP/level)', 'Blessing of the river'],
  } as unknown as Character;
  delete (old as Partial<Character>).spells;
  store.append(g.id, { type: 'character_created', character: old });
  store.append(g.id, { type: 'character_updated', characterId: 'sorcerer', patch: { addFeatures: ['Lucky charm'] } });
  store.append(g.id, { type: 'character_updated', characterId: 'sorcerer', patch: { addFeatures: ['Acorn amulet: once a day, reroll a failed save'] } });
  const c = store.state(g.id).characters[0];
  assert.deepEqual(c.features.map((f) => f.name), ['Darkvision', 'Fey Ancestry', 'Versatile', 'Draconic Bloodline', 'Blessing of the river', 'Lucky charm', 'Acorn amulet']);
  assert.equal(c.features.at(-1)!.text, 'once a day, reroll a failed save');
  assert.ok(c.features[0].text.length > 10);
  assert.equal(c.features.at(-2)!.source, 'other');
  assert.deepEqual(c.spells.map((x) => x.id), ['fire-bolt', 'prestidigitation', 'ray-of-frost', 'light', 'magic-missile', 'chromatic-orb']);
  assert.deepEqual(c.effects, []);
  assert.deepEqual(c.expertise, []);
  const s = sheetOf(c);
  assert.equal(s.attacks.find((a) => a.name === 'Light crossbow')!.ammo, 20);
  assert.equal(s.attacks.find((a) => a.name === 'Dagger')!.count, 2);
});

test('weaponFor: loose old names', () => {
  assert.equal(weaponFor('2 Handaxes')?.id, 'handaxe');
  assert.equal(weaponFor('Longbow + 20 arrows')?.id, 'longbow');
  assert.equal(weaponFor("Explorer's pack"), undefined);
});

test('rolls by name: attack, damage, critical, versatile, errors', () => {
  const m = mira();
  assert.deepEqual(attackRoll(m, 'rapier'), { label: 'Rapier attack', dice: '1d20', modifier: 5 });
  assert.deepEqual(damageRoll(m, 'Rapier', { critical: true }), { label: 'Rapier damage', dice: '2d8', modifier: 3 });
  assert.throws(() => attackRoll(m, 'Greataxe'), /Mira has no weapon or spell "Greataxe". They have: Rapier, Shortbow, Dagger, Unarmed strike/);
  assert.throws(() => damageRoll(m, 'Unarmed strike'), /rolls no dice: it deals 1 damage/);
  const fighter = hero('human', 'fighter');
  assert.equal(damageRoll(fighter, 'Longsword', { versatile: true }).dice, '1d10');
  const wiz = hero('elf', 'wizard');
  assert.throws(() => attackRoll(wiz, 'Burning Hands'), /DEX save against DC 13/);
  assert.deepEqual(damageRoll(wiz, 'Magic Missile'), { label: 'Magic Missile damage (one of 3)', dice: '1d4', modifier: 1 });
  assert.equal(damageRoll(hero('dwarf', 'cleric'), 'cure wounds').label, 'Cure Wounds healing');
});

test('MCP: request_roll by attack/damage, add and remove spells, sheet for players', async () => {
  const { store, db } = newTable();
  const g = store.createGame('T');
  store.setActiveGame(g.id);
  store.append(g.id, { type: 'character_created', character: mira() });
  const dm = await mcpClient(store, db);
  const r = await dm.call('request_roll', { character_id: 'Mira', attack: 'Rapier' });
  assert.match(r.text, /Rapier attack: 1d20 \+5/);
  const d = await dm.call('request_roll', { character_id: 'Mira', damage: 'Dagger', critical: true });
  assert.match(d.text, /Dagger damage: 2d4 \+3/);
  assert.ok((await dm.call('request_roll', { character_id: 'Mira', attack: 'Rapier', check: 'Stealth' })).isError);
  await dm.call('update_character', { character_id: 'Mira', add_spells: ['Light', { name: 'Shadow Step', level: 1, range: '30 ft', summary: 'Teleport between shadows.' }],
    add_features: [{ name: 'Guild contact', text: 'A fence in the docks owes you.' }] });
  let c = store.state(g.id).characters[0];
  assert.deepEqual(c.spells.map((x) => x.id), ['light', 'shadow-step']);
  assert.deepEqual(c.features.at(-1), { name: 'Guild contact', text: 'A fence in the docks owes you.', source: 'other' });
  assert.match(store.state(g.id).log.at(-1)!.text, /spell Light/);
  assert.ok((await dm.call('update_character', { character_id: 'Mira', add_spells: ['Wish'] })).isError);
  await dm.call('update_character', { character_id: 'Mira', remove_spells: ['shadow step'] });
  c = store.state(g.id).characters[0];
  assert.deepEqual(c.spells.map((x) => x.id), ['light']);
  const view = playerView(store.state(g.id));
  assert.equal(view.characters[0].sheet.attacks[0].name, 'Rapier');
  const state = JSON.parse((await dm.call('get_game_state')).text);
  assert.equal(state.characters[0].sheet.attacks[0].toHit, 5);
  assert.equal(state.characters[0].sheet.features, undefined);
});

test('old rogues get Expertise on replay', () => {
  const store = newStore();
  const g = store.createGame('T');
  const old = mira() as Partial<Character>;
  delete old.expertise;
  store.append(g.id, { type: 'character_created', character: old as Character });
  assert.equal(sheetOf(store.state(g.id).characters[0]).skills.find((k) => k.name === 'Stealth')!.mod, 7);
});

test('status effects: add, replace by name, remove, long rest ends them', async () => {
  const { store, db } = newTable();
  const g = store.createGame('T');
  store.setActiveGame(g.id);
  store.append(g.id, { type: 'character_created', character: mira() });
  const dm = await mcpClient(store, db);
  const c = () => store.state(g.id).characters[0];
  const r = await dm.call('update_character', { character_id: 'Mira', add_conditions: ['Poisoned'],
    add_effects: [{ name: 'Blessed', note: '+1d4 to attacks and saves' }, { name: 'Hasted', note: 'double speed' }] });
  assert.match(r.text, /effects: Blessed, Hasted/);
  assert.match(store.state(g.id).log.at(-1)!.text, /condOn Blessed/);
  await dm.call('update_character', { character_id: 'Mira', add_effects: [{ name: 'blessed', note: '+1d4, 1 round left' }], remove_effects: ['Hasted'] });
  assert.deepEqual(c().effects, [{ name: 'blessed', note: '+1d4, 1 round left' }]);
  store.append(g.id, { type: 'rest', kind: 'short', characterIds: [c().id] });
  assert.equal(c().effects.length, 1);
  store.append(g.id, { type: 'rest', kind: 'long', characterIds: [c().id] });
  assert.deepEqual(c().effects, []);
  assert.deepEqual(c().conditions, ['Poisoned']);
});

test('every number on the sheet adds up from its parts', () => {
  const sum = (parts: { value: number }[]) => parts.reduce((n, p) => n + p.value, 0);
  for (const r of RACES) for (const c of CLASSES) {
    const s = sheetOf(hero(r.id, c.id));
    const at = `${r.id} ${c.id}`;
    assert.equal(sum(s.initiativeParts), s.initiative, at);
    assert.equal(sum(s.passivePerceptionParts), s.passivePerception, at);
    for (const x of [...s.skills, ...s.saves]) assert.equal(sum(x.parts), x.mod, at);
    for (const a of s.attacks) {
      assert.equal(sum(a.toHitParts), a.toHit, `${at} ${a.name}`);
      assert.equal(sum(a.bonusParts), a.bonus, `${at} ${a.name}`);
    }
    if (s.spellcasting) {
      assert.equal(sum(s.spellcasting.attackParts), s.spellcasting.attack, at);
      assert.equal(sum(s.spellcasting.saveDcParts), s.spellcasting.saveDc, at);
    }
  }
  const dc = sheetOf(hero('elf', 'wizard')).spellcasting!.saveDcParts;
  assert.deepEqual(dc, [{ from: 'base', value: 8 }, { from: 'ability', ability: 'int', value: 3 }, { from: 'proficiency', value: 2 }]);
});

test('item notes: given by the DM, kept on more of the same, and old bracketed descriptions become notes', async () => {
  const { store, db } = newTable();
  const g = store.createGame('T');
  store.setActiveGame(g.id);
  store.append(g.id, { type: 'character_created', character: mira() });
  // Before items had notes, the DM wrote the description into the name.
  store.append(g.id, { type: 'character_updated', characterId: 'mira', patch: { addItems: [{ name: 'Murun kristalli (hehkuu sinistä; kerran: murskaa ja paranna 2d4+2)' }, { name: 'Rope (50 ft)' }] } });
  const item = (n: string) => store.state(g.id).characters[0].inventory.find((i) => i.name === n);
  assert.deepEqual(item('Murun kristalli'), { name: 'Murun kristalli', qty: 1, note: 'hehkuu sinistä; kerran: murskaa ja paranna 2d4+2' });
  assert.deepEqual(item('Rope (50 ft)'), { name: 'Rope (50 ft)', qty: 1 }); // too short to be a description
  store.append(g.id, { type: 'character_updated', characterId: 'mira', patch: { removeItems: [{ name: 'Murun kristalli (hehkuu sinistä; kerran: murskaa ja paranna 2d4+2)' }] } });
  assert.equal(item('Murun kristalli'), undefined);

  const dm = await mcpClient(store, db);
  await dm.call('update_character', { character_id: 'Mira', add_items: [{ name: 'Silver key', note: 'Opens something in the bell tower' }] });
  await dm.call('update_character', { character_id: 'Mira', add_items: [{ name: 'silver key' }] });
  assert.deepEqual(item('Silver key'), { name: 'Silver key', qty: 2, note: 'Opens something in the bell tower' });
  await dm.call('update_character', { character_id: 'Mira', add_items: [{ name: 'Silver key', qty: 0, note: 'Opens the bell tower crypt' }] });
  assert.deepEqual(item('Silver key'), { name: 'Silver key', qty: 2, note: 'Opens the bell tower crypt' });
  assert.equal(sheetOf(store.state(g.id).characters[0]).inventory.find((i) => i.name === 'Silver key')!.note, 'Opens the bell tower crypt');
});

test('inventory: weapons point at their attack, armour says the AC it gives', () => {
  const inv = (c: Character, name: string) => sheetOf(c).inventory.find((i) => i.name === name)!;
  const m = mira(); // DEX +3
  assert.equal(inv(m, 'Rapier').weaponId, 'rapier');
  const leather = inv(m, 'Leather armour').armour!;
  assert.equal(leather.kind, 'light');
  assert.equal(leather.acParts.reduce((n, p) => n + p.value, 0), m.ac); // 11 + DEX 3
  const cleric = hero('human', 'cleric');
  const scale = inv(cleric, 'Scale mail').armour!;
  assert.deepEqual([scale.kind, scale.dexMax, scale.stealth], ['medium', 2, true]);
  assert.ok(scale.acParts.every((p) => p.from !== 'ability' || p.value <= 2));
  assert.deepEqual(inv(cleric, 'Shield').armour!.acParts, [{ from: 'bonus', value: 2 }]);
  const druid = hero('human', 'druid');
  assert.equal(inv(druid, 'Wooden shield').armour!.id, 'shield');
});
