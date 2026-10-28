// Everything a hero's sheet shows that follows from the rules: attack bonuses, damage, spell
// numbers, skill modifiers. Computed on read, never stored, so it can't drift from the character.
// Each number comes with its parts (ability, proficiency…) so the page can show how it adds up.

import { abilityPart, ABILITIES, checkModifier, CLASSES, mod, SKILLS, total, type Ability, type Character, type Feature, type Part } from './rules.ts';
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
  spellcasting?: { ability: Ability; attack: number; attackParts: Part[]; saveDc: number; saveDcParts: Part[]; slots: string };
  spells: SheetSpell[];
  features: Feature[];
  inventory: { name: string; qty: number; note?: string; kind: 'weapon' | 'armour' | 'ammo' | 'gear' }[];
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
  const out: Attack[] = [...counts].map(([w, count]) => {
    const ability = weaponAbility(c, w);
    const toHitParts = [abilityPart(c, ability), prof];
    const bonusParts = [abilityPart(c, ability)];
    const bonus = total(bonusParts);
    return {
      name: w.name, weaponId: w.id, ability, toHit: total(toHitParts), toHitParts,
      dice: w.damage, bonus, bonusParts, damage: showDamage(w.damage, bonus), damageType: w.damageType,
      ...(w.versatile ? { versatile: w.versatile } : {}),
      ...(w.range ?? w.thrown ? { range: w.range ?? w.thrown } : {}),
      properties: properties(w), count,
      ...(w.ammo ? { ammo: ammoCount(c.inventory, w.ammo) } : {}),
    };
  });
  const monk = c.classId === 'monk';
  const ability: Ability = monk && mod(c.abilities.dex) > mod(c.abilities.str) ? 'dex' : 'str';
  const toHitParts = [abilityPart(c, ability), prof];
  // A punch without martial arts deals 1 + STR, no dice.
  const bonusParts: Part[] = monk ? [abilityPart(c, ability)] : [{ from: 'base', value: 1 }, abilityPart(c, ability)];
  const bonus = total(bonusParts);
  out.push({
    name: 'Unarmed strike', ability, toHit: total(toHitParts), toHitParts, ...(monk ? { dice: '1d4' } : {}), bonus, bonusParts,
    damage: showDamage(monk ? '1d4' : undefined, bonus), damageType: 'bludgeoning', properties: [], count: 1,
  });
  return out;
}

/** Whose numbers a hero's spells use: the class's casting ability, or CHA for innate magic. */
export function spellcasting(c: Character): Sheet['spellcasting'] {
  const cls = CLASSES.find((x) => x.id === c.classId)?.spellcasting;
  if (!cls && !c.spells.length) return undefined;
  const ability = cls?.ability ?? 'cha';
  const attackParts: Part[] = [abilityPart(c, ability), { from: 'proficiency', value: c.proficiencyBonus }];
  const saveDcParts: Part[] = [{ from: 'base', value: 8 }, ...attackParts];
  return { ability, attack: total(attackParts), attackParts, saveDc: total(saveDcParts), saveDcParts, slots: cls?.slots ?? '' };
}

function spells(c: Character, casting: Sheet['spellcasting']): SheetSpell[] {
  if (!casting) return [];
  return c.spells.map((s) => {
    const rollParts: Part[] = [...(s.addMod ? [abilityPart(c, casting.ability)] : []), ...(s.bonus ? [{ from: 'bonus' as const, value: s.bonus }] : [])];
    const bonus = total(rollParts);
    const slot = s.level > 0 && c.resources.some((r) => r.id === casting.slots) ? casting.slots : undefined;
    return {
      ...s,
      ...(s.attack ? { toHit: casting.attack } : {}),
      ...(s.save ? { saveDc: casting.saveDc } : {}),
      ...(s.dice ? { roll: showDamage(s.dice, bonus, s.times), rollParts } : {}),
      ...(slot ? { resourceId: slot } : {}),
    };
  });
}

function itemKind(name: string): Sheet['inventory'][number]['kind'] {
  if (weaponFor(name)) return 'weapon';
  if (AMMO.some((a) => a.toLowerCase() === name.toLowerCase())) return 'ammo';
  if (/armou?r|mail|shield|plate/i.test(name)) return 'armour';
  return 'gear';
}

export function sheetOf(c: Character): Sheet {
  const casting = spellcasting(c);
  const skills = Object.entries(SKILLS).map(([name, ability]) => {
    const { modifier, parts } = checkModifier(c, name);
    return { name, ability, mod: modifier, parts, proficient: c.skills.includes(name), expertise: c.expertise.includes(name) };
  });
  const passivePerceptionParts: Part[] = [{ from: 'base', value: 10 }, ...skills.find((x) => x.name === 'Perception')!.parts];
  const initiativeParts = [abilityPart(c, 'dex')];
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
    features: c.features,
    inventory: c.inventory.map((i) => ({ ...i, kind: itemKind(i.name) })),
  };
}

export interface NamedRoll { label: string; dice: string; modifier: number }

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
  if (attack) return { label: `${attack.name} attack`, dice: '1d20', modifier: attack.toHit };
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
