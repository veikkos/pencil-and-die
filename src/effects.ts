// What spell and feature effects do to a hero's numbers. An effect carries its numbers (`mods`),
// filled in from the presets below when the DM names a known one, so the stored event keeps them
// even if the presets change. The sheet, monster attacks and damage read the numbers through here.

import type { Character, Effect } from './rules.ts';

export type DamageKind = string;

export interface EffectMods {
  /** Added to AC (Shield of Faith +2, Shield +5). */
  ac?: number;
  /** AC is at least this + DEX while it lasts (Mage Armor 13). */
  acBase?: number;
  /** Added to the damage of melee weapon attacks with Strength (Rage). */
  meleeDamage?: number;
  /** Damage types that are halved. */
  resist?: DamageKind[];
  /** Over when the fight is (Rage, Shield). */
  endsWithFight?: boolean;
  /** A die added to attack rolls and saving throws (Bless 1d4); the player throws it too. */
  rollDice?: string;
}

const PHYSICAL = ['bludgeoning', 'piercing', 'slashing'];

/** Known effects by English or Finnish name. */
const PRESETS: [RegExp, (c: Character) => EffectMods][] = [
  [/^(rage|raging|raivo|raivoissaan)$/i, (c) => ({ meleeDamage: c.level >= 9 ? 3 : 2, resist: PHYSICAL, endsWithFight: true })],
  [/^(mage armou?r|taikahaarniska)$/i, () => ({ acBase: 13 })],
  [/^(bless|blessed|siunattu|siunaus)$/i, () => ({ rollDice: '1d4' })],
  [/^(shield of faith|uskon kilpi)$/i, () => ({ ac: 2 })],
  [/^(shield|suojakilpi|kilpiloitsu)$/i, () => ({ ac: 5, endsWithFight: true })],
];

export function presetMods(c: Character, name: string): EffectMods | undefined {
  return PRESETS.find(([re]) => re.test(name.trim()))?.[1](c);
}

const mods = (c: Character) => c.effects.map((e: Effect) => e.mods ?? {});
const dexMod = (c: Character) => Math.floor((c.abilities.dex - 10) / 2);

/** The AC the hero has right now, effects included. */
export function armorClass(c: Character): number {
  const base = Math.max(c.ac, ...mods(c).filter((m) => m.acBase !== undefined).map((m) => m.acBase! + dexMod(c)));
  return base + mods(c).reduce((n, m) => n + (m.ac ?? 0), 0);
}

export const meleeDamageBonus = (c: Character) => mods(c).reduce((n, m) => n + (m.meleeDamage ?? 0), 0);

/** Resistances a hero's race or class gives for good, by feature name. */
const FEATURE_RESIST: Record<string, DamageKind[]> = {
  'Dwarven Resilience': ['poison'],
  'Damage Resistance': ['fire'], // a red dragonborn's ancestry
  'Hellish Resistance': ['fire'],
};

export const resists = (c: Character, type: DamageKind | undefined) => {
  if (!type) return false;
  const t = type.toLowerCase();
  return mods(c).some((m) => m.resist?.includes(t)) || c.features.some((f) => FEATURE_RESIST[f.name]?.includes(t));
};

/** Extra dice a hero adds to attacks and saves (Bless), with the effect they come from. */
export const rollBonusDice = (c: Character) =>
  c.effects.filter((e) => e.mods?.rollDice).map((e) => ({ dice: e.mods!.rollDice!, from: e.name }));

/** The heroes' effects that end with the fight, by name. */
export const fightEffects = (c: Character) => c.effects.filter((e) => e.mods?.endsWithFight).map((e) => e.name);
