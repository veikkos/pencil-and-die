// Everything a hero's sheet shows that follows from the rules: attack bonuses, damage, spell
// numbers, skill modifiers. Computed on read, never stored, so it can't drift from the character.
// Each number comes with its parts (ability, proficiency…) so the page can show how it adds up.

import { canLevel, featureValue, MAX_LEVEL, XP_FOR_LEVEL } from './levels.ts';
import { abilityPart, ABILITIES, checkModifier, CLASSES, jackPart, mod, SKILLS, total, type Ability, type Character, type Feature, type Part } from './rules.ts';
import { armourFor, type Armour } from './armour.ts';
import type { Spell } from './spells.ts';
import { AMMO, ammoCount, countIn, weaponFor, type Weapon } from './weapons.ts';

export interface Attack {
  name: string;
  weaponId?: string;
  ability: Ability;
  toHit: number;
  toHitParts: Part[];
  /** Dice to roll for damage; absent when the damage is a flat number (a plain punch). */
  dice?: string;
  bonus: number;
  bonusParts: Part[];
  /** Ready to show: "1d8+3". */
  damage: string;
  damageType: string;
  /** Damage die in two hands. */
  versatile?: string;
  range?: string;
  properties: string[];
  /** How many the hero carries (thrown weapons run out). */
  count: number;
  /** Ammunition left for weapons that shoot it. */
  ammo?: number;
  /** Lowest d20 roll that is a critical hit (19 for a Champion). */
  critOn: number;
}

export interface SheetSpell extends Spell {
  toHit?: number;
  saveDc?: number;
  /** Ready to show: "1d8+3", "1d4+1 ×3". */
  roll?: string;
  /** What is added to each roll of the dice. */
  rollParts?: Part[];
  /** The slot it spends; cantrips spend nothing. */
  resourceId?: string;
}

export interface Sheet {
  proficiency: number;
  initiative: number;
  initiativeParts: Part[];
  passivePerception: number;
  passivePerceptionParts: Part[];
  saves: { ability: Ability; mod: number; parts: Part[]; proficient: boolean }[];
  skills: { name: string; ability: Ability; mod: number; parts: Part[]; proficient: boolean; expertise: boolean }[];
  attacks: Attack[];
  spellcasting?: { ability: Ability; attack: number; attackParts: Part[]; saveDc: number; saveDcParts: Part[]; slots: Record<number, string> };
  spells: SheetSpell[];
  /** Attacks per Attack action: 2 with Extra Attack. */
  attacksPerAction: number;
  /** XP for the next level; absent at the highest level. */
  xpNext?: number;
  /** Enough XP for the next level (the DM decides when it happens). */
  canLevel: boolean;
  features: (Feature & { value?: string })[];
  inventory: SheetItem[];
}

export interface SheetItem {
  name: string;
  qty: number;
  note?: string;
  kind: 'weapon' | 'armour' | 'ammo' | 'gear';
  /** A weapon's stats are in `attacks` under this id. */
  weaponId?: string;
  /** Armour with the AC it gives this hero; for a shield, what it adds. */
  armour?: Armour & { acParts: Part[] };
}

const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
export const showDamage = (dice: string | undefined, bonus: number, times = 1) =>
  `${dice ? `${dice}${bonus ? sign(bonus) : ''}` : Math.max(1, bonus)}${times > 1 ? ` ×${times}` : ''}`;

function weaponAbility(c: Character, w: Weapon): Ability {
  const m = (a: Ability) => mod(c.abilities[a]);
  const best: Ability = m('dex') > m('str') ? 'dex' : 'str';
  if (w.finesse) return best;
  // Monk weapons: anything light enough to fight with in the monk's style.
  if (c.classId === 'monk' && w.kind === 'melee' && !w.heavy && !w.twoHanded) return best;
  return w.kind === 'ranged' ? 'dex' : 'str';
}

function properties(w: Weapon): string[] {
  return [
    w.finesse && 'finesse', w.light && 'light', w.heavy && 'heavy', w.twoHanded && 'two-handed', w.reach && 'reach',
    w.versatile && `versatile (${w.versatile})`, w.thrown && `thrown (${w.thrown})`,
  ].filter((x): x is string => !!x);
}

function attacks(c: Character): Attack[] {
  const counts = new Map<Weapon, number>();
  for (const i of c.inventory) {
    const w = weaponFor(i.name);
    if (w) counts.set(w, (counts.get(w) ?? 0) + countIn(i.name) * i.qty);
  }
  const prof: Part = { from: 'proficiency', value: c.proficiencyBonus };
  const has = (name: string) => c.features.some((f) => f.name === name);
  const critOn = has('Improved Critical') ? 19 : 20;
  const archery: Part[] = has('Fighting Style: Archery') ? [{ from: 'bonus', value: 2 }] : [];
  const out: Attack[] = [...counts].map(([w, count]) => {
    const ability = weaponAbility(c, w);
    const toHitParts = [abilityPart(c, ability), prof, ...(w.kind === 'ranged' ? archery : [])];
    const bonusParts = [abilityPart(c, ability)];
    const bonus = total(bonusParts);
    return {
      name: w.name, weaponId: w.id, ability, toHit: total(toHitParts), toHitParts,
      dice: w.damage, bonus, bonusParts, damage: showDamage(w.damage, bonus), damageType: w.damageType,
      ...(w.versatile ? { versatile: w.versatile } : {}),
      ...(w.range ?? w.thrown ? { range: w.range ?? w.thrown } : {}),
      properties: properties(w), count,
      ...(w.ammo ? { ammo: ammoCount(c.inventory, w.ammo) } : {}),
      critOn,
    };
  });
  const monk = c.classId === 'monk';
  const martialDie = featureValue(c, 'Martial Arts')!;
  const ability: Ability = monk && mod(c.abilities.dex) > mod(c.abilities.str) ? 'dex' : 'str';
  const toHitParts = [abilityPart(c, ability), prof];
  // A punch without martial arts deals 1 + STR, no dice.
  const bonusParts: Part[] = monk ? [abilityPart(c, ability)] : [{ from: 'base', value: 1 }, abilityPart(c, ability)];
  const bonus = total(bonusParts);
  out.push({
    name: 'Unarmed strike', ability, toHit: total(toHitParts), toHitParts, ...(monk ? { dice: martialDie } : {}), bonus, bonusParts,
    damage: showDamage(monk ? martialDie : undefined, bonus), damageType: 'bludgeoning', properties: [], count: 1, critOn,
  });
  return out;
}

/** Whose numbers a hero's spells use: the class's casting ability, or CHA for innate magic. */
export function spellcasting(c: Character): Sheet['spellcasting'] {
  const cls = CLASSES.find((x) => x.id === c.classId)?.spellcasting;
  if (!c.spells.length) return undefined;
  const ability = cls?.ability ?? 'cha';
  const attackParts: Part[] = [abilityPart(c, ability), { from: 'proficiency', value: c.proficiencyBonus }];
  const saveDcParts: Part[] = [{ from: 'base', value: 8 }, ...attackParts];
  // Which slot each spell level spends: a warlock's pact slots cast every spell they can.
  const slots: Record<number, string> = {};
  for (const r of c.resources) {
    const n = /^spell-slots-(\d)$/.exec(r.id)?.[1];
    if (n) slots[Number(n)] = r.id;
    if (r.id === 'pact-slot') for (let l = 1; l <= (r.slotLevel ?? 1); l++) slots[l] = r.id;
  }
  return { ability, attack: total(attackParts), attackParts, saveDc: total(saveDcParts), saveDcParts, slots };
}

function spells(c: Character, casting: Sheet['spellcasting']): SheetSpell[] {
  if (!casting) return [];
  const agonizing = c.features.some((f) => f.name === 'Eldritch Invocation: Agonizing Blast');
  return c.spells.map((base) => {
    const s = scaleCantrip(c, base);
    const addMod = s.addMod || (agonizing && s.id === 'eldritch-blast');
    const rollParts: Part[] = [...(addMod ? [abilityPart(c, casting.ability)] : []), ...(s.bonus ? [{ from: 'bonus' as const, value: s.bonus }] : [])];
    const bonus = total(rollParts);
    const slot = s.level > 0 ? casting.slots[s.level] : undefined;
    return {
      ...s,
      ...(s.attack ? { toHit: casting.attack } : {}),
      ...(s.save ? { saveDc: casting.saveDc } : {}),
      ...(s.dice ? { roll: showDamage(s.dice, bonus, s.times), rollParts } : {}),
      ...(slot ? { resourceId: slot } : {}),
    };
  });
}

/** Damage cantrips grow at level 5: twice the dice, or two beams of Eldritch Blast. */
function scaleCantrip(c: Character, s: Spell): Spell {
  if (s.level !== 0 || !s.dice || c.level < 5) return s;
  if (s.id === 'eldritch-blast') return { ...s, times: 2 };
  return { ...s, dice: s.dice.replace(/^(\d*)d/, (_, n) => `${2 * Number(n || 1)}d`) };
}

function sheetItem(c: Character, i: Character['inventory'][number]): SheetItem {
  const w = weaponFor(i.name);
  if (w) return { ...i, kind: 'weapon', weaponId: w.id };
  if (AMMO.some((a) => a.toLowerCase() === i.name.toLowerCase())) return { ...i, kind: 'ammo' };
  const a = armourFor(i.name);
  if (a) {
    const dex = abilityPart(c, 'dex');
    const acParts: Part[] = a.kind === 'shield' ? [{ from: 'bonus', value: a.ac }]
      : [{ from: 'base', value: a.ac }, ...(a.dexMax === 0 ? [] : [{ ...dex, value: Math.min(dex.value, a.dexMax ?? Infinity) }])];
    return { ...i, kind: 'armour', armour: { ...a, acParts } };
  }
  return { ...i, kind: /armou?r|mail|shield|plate/i.test(i.name) ? 'armour' : 'gear' };
}

export function sheetOf(c: Character): Sheet {
  const casting = spellcasting(c);
  const skills = Object.entries(SKILLS).map(([name, ability]) => {
    const { modifier, parts } = checkModifier(c, name);
    return { name, ability, mod: modifier, parts, proficient: c.skills.includes(name), expertise: c.expertise.includes(name) };
  });
  const passivePerceptionParts: Part[] = [{ from: 'base', value: 10 }, ...skills.find((x) => x.name === 'Perception')!.parts];
  const initiativeParts = [abilityPart(c, 'dex'), ...jackPart(c)];
  return {
    proficiency: c.proficiencyBonus,
    initiative: total(initiativeParts),
    initiativeParts,
    passivePerception: total(passivePerceptionParts),
    passivePerceptionParts,
    saves: ABILITIES.map((a) => {
      const { modifier, parts } = checkModifier(c, `${a} save`);
      return { ability: a, mod: modifier, parts, proficient: c.saves.includes(a) };
    }),
    skills,
    attacks: attacks(c),
    ...(casting ? { spellcasting: casting } : {}),
    spells: spells(c, casting),
    attacksPerAction: c.features.some((f) => f.name === 'Extra Attack') ? 2 : 1,
    ...(c.level < MAX_LEVEL ? { xpNext: XP_FOR_LEVEL[c.level + 1] } : {}),
    canLevel: canLevel(c),
    features: c.features.map((f) => {
      const value = featureValue(c, f.name);
      return value ? { ...f, value } : f;
    }),
    inventory: c.inventory.map((i) => sheetItem(c, i)),
  };
}

export interface NamedRoll { label: string; dice: string; modifier: number; critOn?: number }

const findAction = (c: Character, name: string) => {
  const key = name.trim().toLowerCase();
  const sheet = sheetOf(c);
  const attack = sheet.attacks.find((a) => a.name.toLowerCase() === key || a.weaponId === key);
  const spell = sheet.spells.find((s) => s.name.toLowerCase() === key || s.id === key);
  if (!attack && !spell) {
    const known = [...sheet.attacks.map((a) => a.name), ...sheet.spells.filter((s) => s.attack || s.dice).map((s) => s.name)];
    throw new Error(`${c.name} has no weapon or spell "${name}". They have: ${known.join(', ')}.`);
  }
  return { attack, spell };
};

/** The d20 roll to hit with a weapon or attack spell. */
export function attackRoll(c: Character, name: string): NamedRoll {
  const { attack, spell } = findAction(c, name);
  if (attack) return { label: `${attack.name} attack`, dice: '1d20', modifier: attack.toHit, ...(attack.critOn < 20 ? { critOn: attack.critOn } : {}) };
  if (spell!.toHit !== undefined) return { label: `${spell!.name} attack`, dice: '1d20', modifier: spell!.toHit };
  if (spell!.saveDc !== undefined) throw new Error(`${spell!.name} needs no attack roll: the targets make a ${spell!.save!.toUpperCase()} save against DC ${spell!.saveDc} (roll theirs with dm_roll).`);
  throw new Error(`${spell!.name} needs no attack roll${spell!.dice ? '; ask for its damage roll instead' : ''}.`);
}

/** The damage (or healing) roll of a weapon or spell. A critical hit doubles the dice. */
export function damageRoll(c: Character, name: string, opts: { critical?: boolean; versatile?: boolean } = {}): NamedRoll {
  const { attack, spell } = findAction(c, name);
  let dice = attack ? (opts.versatile && attack.versatile) || attack.dice : spell!.dice;
  const flat = attack ? attack.bonus : total(spell!.rollParts ?? []);
  const what = attack?.name ?? spell!.name;
  if (!dice) throw new Error(`${what} rolls no dice: it deals ${Math.max(1, flat)} damage.`);
  if (opts.critical) dice = dice.replace(/^(\d*)d/, (_, n) => `${2 * Number(n || 1)}d`);
  const times = spell?.times ?? 1;
  const label = `${what} ${spell?.heal ? 'healing' : 'damage'}${times > 1 ? ` (one of ${times})` : ''}`;
  return { label, dice, modifier: flat };
}
