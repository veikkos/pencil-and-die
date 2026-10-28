import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLevel, classSpellIds, levelOptions, levelUp, withRecommended } from '../src/levels.ts';
import { buildCharacter, CLASSES, mod, RACES, type Character } from '../src/rules.ts';
import { sheetOf } from '../src/sheet.ts';
import { findSpell } from '../src/spells.ts';
import { mcpClient, mira, newTable } from './helpers.ts';

const hero = (race: string, className: string) => buildCharacter(className, { name: className, player: '', race, className, preset: 'specialist' });
const up = (c: Character) => applyLevel(c, levelUp(c, withRecommended(levelOptions(c))));
const to = (c: Character, level: number) => { while (c.level < level) c = up(c); return c; };
const sum = (parts: { value: number }[]) => parts.reduce((n, p) => n + p.value, 0);
const res = (c: Character, id: string) => c.resources.find((r) => r.id === id);

test('levels: every class and race reaches level 5 with numbers that add up', () => {
  for (const r of RACES) for (const cls of CLASSES) {
    const c = to(hero(r.id, cls.id), 5);
    const at = `${r.id} ${cls.id}`;
    assert.equal(c.level, 5, at);
    assert.equal(c.proficiencyBonus, 3, at);
    assert.equal(res(c, 'hit-dice')!.max, 5, at);
    assert.equal(c.hp, c.maxHp, at);
    const s = sheetOf(c);
    for (const x of [...s.skills, ...s.saves]) assert.equal(sum(x.parts), x.mod, `${at} ${x.ability}`);
    for (const a of s.attacks) assert.equal(sum(a.toHitParts), a.toHit, `${at} ${a.name}`);
    assert.equal(sum(s.initiativeParts), s.initiative, at);
    if (s.spellcasting) assert.equal(sum(s.spellcasting.saveDcParts), s.spellcasting.saveDc, at);
    for (const sp of s.spells) if (sp.level > 0) assert.ok(sp.resourceId, `${at} ${sp.name} has a slot`);
  }
});

test('levels: HP is the average of the hit die plus CON, every level', () => {
  const f = hero('human', 'fighter'); // CON 14 + 1 = 15 (+2), d10 → 6 + 2 per level
  const f2 = up(f);
  assert.equal(f2.maxHp - f.maxHp, 8);
  const dwarf = hero('dwarf', 'wizard'); // d6 → 4, CON +2 (14+2=16 → +3), hill dwarf +1
  assert.equal(up(dwarf).maxHp - dwarf.maxHp, 4 + mod(dwarf.abilities.con) + 1);
});

test('levels: spell slots, pact slots and uses follow the class tables', () => {
  const w = to(hero('elf', 'wizard'), 5);
  assert.deepEqual([1, 2, 3].map((n) => res(w, `spell-slots-${n}`)!.max), [4, 3, 2]);
  const p = hero('human', 'paladin');
  assert.equal(res(p, 'spell-slots-1'), undefined);
  assert.equal(res(up(p), 'spell-slots-1')!.max, 2);
  assert.equal(res(to(p, 5), 'lay-on-hands')!.max, 25);
  const wl = to(hero('human', 'warlock'), 3);
  assert.deepEqual([res(wl, 'pact-slot')!.max, res(wl, 'pact-slot')!.slotLevel], [2, 2]);
  assert.equal(sheetOf(wl).spells.find((x) => x.level === 2)!.resourceId, 'pact-slot');
  assert.equal(res(to(hero('human', 'barbarian'), 3), 'rage')!.max, 3);
  assert.equal(res(to(hero('human', 'monk'), 4), 'ki')!.max, 4);
  const b = to(hero('human', 'bard'), 5);
  assert.equal(res(b, 'bardic-inspiration')!.recharge, 'short');
});

test('levels: spent uses stay spent, new slots arrive fresh', () => {
  let w = hero('elf', 'wizard');
  w = { ...w, resources: w.resources.map((r) => (r.id === 'spell-slots-1' ? { ...r, used: 2 } : r)) };
  const w2 = up(w);
  assert.deepEqual([res(w2, 'spell-slots-1')!.used, res(w2, 'spell-slots-1')!.max], [2, 3]);
});

test('levels: features, spells and numbers that grow with level', () => {
  const rogue = to(mira(), 5);
  const s = sheetOf(rogue);
  assert.equal(s.features.find((f) => f.name === 'Sneak Attack')!.value, '3d6');
  assert.equal(s.features.find((f) => f.name === 'Uncanny Dodge')!.level, 5);
  assert.equal(s.attacksPerAction, 1);

  const fighter = to(hero('human', 'fighter'), 5);
  const fs = sheetOf(fighter);
  assert.equal(fs.attacksPerAction, 2);
  assert.equal(fs.attacks[0].critOn, 19);

  const wiz = sheetOf(to(hero('elf', 'wizard'), 5));
  assert.equal(wiz.spells.find((x) => x.id === 'fire-bolt')!.roll, '2d10');
  assert.ok(wiz.spells.some((x) => x.level === 3), 'a 3rd-level spell picked');

  const wl = sheetOf(to(hero('human', 'warlock'), 5));
  assert.equal(wl.spells.find((x) => x.id === 'eldritch-blast')!.roll, '1d10+4 ×2'); // CHA 16 +2 at level 4 (+4), from Agonizing Blast
  assert.ok(wl.spells.some((x) => x.id === 'sacred-flame'), 'Pact of the Tome cantrips');

  const ranger = sheetOf(to(hero('human', 'ranger'), 2));
  const bow = ranger.attacks.find((a) => a.name === 'Longbow')!;
  assert.ok(bow.toHitParts.some((p) => p.from === 'bonus' && p.value === 2), 'Archery');

  const monk = to(hero('human', 'monk'), 5);
  assert.equal(sheetOf(monk).attacks.find((a) => a.name === 'Unarmed strike')!.dice, '1d6');
  assert.equal(monk.speed, 40);

  const cleric = to(hero('dwarf', 'cleric'), 5);
  assert.ok(['spiritual-weapon', 'revivify'].every((id) => cleric.spells.some((x) => x.id === id)), 'domain spells');
});

test('levels: the bard picks skills and Expertise, and Jack of All Trades counts', () => {
  const b = to(hero('human', 'bard'), 2);
  const s = sheetOf(b);
  const athletics = s.skills.find((k) => k.name === 'Athletics')!;
  assert.ok(athletics.parts.some((p) => p.from === 'half' && p.value === 1));
  const o = levelOptions(b);
  assert.equal(o.choices.skills!.count, 3);
  const b3 = applyLevel(b, levelUp(b, withRecommended(o, { skills: ['Stealth', 'Athletics', 'Arcana'], expertise: ['Stealth', 'Persuasion'] })));
  assert.ok(b3.expertise.includes('Stealth'));
  assert.ok(b3.features.some((f) => f.name === 'Bardic Expertise'));
  assert.throws(() => levelUp(b, withRecommended(o, { expertise: ['History', 'Persuasion'] })), /needs proficiency/);
});

test('levels: level 4 raises ability scores; CON counts for earlier levels, AC follows unless set by hand', () => {
  const monk = to(hero('human', 'monk'), 3); // AC 10 + DEX + WIS
  const o = levelOptions(monk);
  assert.ok(o.choices.asi);
  const g = levelUp(monk, { asi: { dex: 1, con: 1 } });
  assert.equal(g.abilities.dex, monk.abilities.dex + 1);
  const conUp = mod(g.abilities.con) - mod(monk.abilities.con);
  assert.equal(g.hpGain, 5 + mod(g.abilities.con) + conUp * 3);
  const dexUp = mod(g.abilities.dex) - mod(monk.abilities.dex);
  assert.equal(g.ac, monk.ac + dexUp);
  assert.equal(levelUp({ ...monk, ac: 20 }, { asi: { dex: 1, con: 1 } }).ac, 20);
  assert.throws(() => levelUp(monk, { asi: { dex: 3 } }), /\+2 to one/);
  assert.throws(() => levelUp(monk, {}), /\+2 to one/);
});

test('levels: a paladin with Defense gets +1 AC at level 2', () => {
  const p = hero('human', 'paladin');
  assert.equal(up(p).ac, p.ac + 1);
});

test('levels: spell picks must come from the list, the right number of them', () => {
  const w = hero('elf', 'wizard');
  const o = levelOptions(w);
  assert.equal(o.choices.spells!.count, 2);
  assert.throws(() => levelUp(w, { spells: ['fireball', 'thunderwave'] }), /isn't one of/);
  assert.throws(() => levelUp(w, { spells: ['thunderwave'] }), /Pick 2/);
  assert.equal(levelUp(w, { spells: ['Thunderwave', 'feather-fall'] }).spells.length, w.spells.length + 2);
  assert.throws(() => levelOptions(to(w, 5)), /level 5/);
});

test('levels: every class spell list names real spells', () => {
  for (const cls of CLASSES) for (const id of classSpellIds(cls.id)) assert.ok(findSpell(id), `${cls.id}: ${id}`);
});

test('level_up: the DM offers, the player chooses on the page, the DM hears it', async () => {
  const { store, db } = newTable();
  const g = store.createGame('T');
  store.setActiveGame(g.id);
  store.append(g.id, { type: 'character_created', character: hero('elf', 'wizard') });
  const mcp = await mcpClient(store, db);
  const xp = await mcp.call('update_character', { character_id: 'wizard', xp_delta: 300 });
  assert.match(xp.text, /enough XP for level 2/);

  const offered = await mcp.call('level_up', { character_id: 'wizard' });
  assert.match(offered.text, /choosing on the page/);
  let c = store.state(g.id).characters[0];
  assert.equal(c.pendingLevel, 2);
  assert.equal(c.level, 1);

  await mcp.call('wait_for_players', { timeout_seconds: 5 }); // clear the queue
  const gains = levelUp(c, { spells: ['thunderwave', 'feather-fall'] });
  store.append(g.id, { type: 'character_levelled', characterId: c.id, gains, by: 'player' });
  c = store.state(g.id).characters[0];
  assert.equal(c.level, 2);
  assert.equal(c.pendingLevel, undefined);
  const heard = await mcp.call('wait_for_players', { timeout_seconds: 5 });
  assert.match(heard.text, /LEVEL UP/);
  assert.match(heard.text, /Thunderwave/);

  const direct = await mcp.call('level_up', { character_id: 'wizard', pick: 'recommended' });
  assert.match(direct.text, /level 3/);
  assert.equal(store.state(g.id).characters[0].level, 3);

  const before = store.state(g.id).seq;
  await mcp.call('level_up', { character_id: 'wizard', choices: { spells: ['web', 'blur'] } });
  store.rewind(g.id, before);
  assert.equal(store.state(g.id).characters[0].level, 3);
});

test('level_up: a level without choices applies at once', async () => {
  const { store, db } = newTable();
  const g = store.createGame('T');
  store.setActiveGame(g.id);
  store.append(g.id, { type: 'character_created', character: hero('human', 'fighter') });
  const mcp = await mcpClient(store, db);
  const r = await mcp.call('level_up', { character_id: 'fighter' });
  assert.match(r.text, /Action Surge/);
  assert.equal(store.state(g.id).characters[0].level, 2);
});

test('request_roll: a Champion\'s 19 is reported as a critical hit', async () => {
  const { store, db } = newTable();
  const g = store.createGame('T');
  store.setActiveGame(g.id);
  store.append(g.id, { type: 'character_created', character: to(hero('human', 'fighter'), 3) });
  const mcp = await mcpClient(store, db);
  await mcp.call('wait_for_players', { timeout_seconds: 5 });
  await mcp.call('request_roll', { character_id: 'fighter', attack: 'Longsword' });
  const roll = store.state(g.id).pendingRolls[0];
  assert.equal(roll.critOn, 19);
  store.append(g.id, { type: 'roll_resolved', rollId: roll.rollId, faces: [19], total: 19 + roll.modifier });
  assert.match((await mcp.call('wait_for_players', { timeout_seconds: 5 })).text, /CRITICAL HIT/);
});
