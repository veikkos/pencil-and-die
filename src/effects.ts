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
}

const PHYSICAL = ['bludgeoning', 'piercing', 'slashing'];

/** Known effects by English or Finnish name. */
const PRESETS: [RegExp, (c: Character) => EffectMods][] = [
  [/^(rage|raging|raivo|raivoissaan)$/i, (c) => ({ meleeDamage: c.level >= 9 ? 3 : 2, resist: PHYSICAL, endsWithFight: true })],
  [/^(mage armou?r|taikahaarniska)$/i, () => ({ acBase: 13 })],
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

export const resists = (c: Character, type: DamageKind | undefined) =>
  !!type && mods(c).some((m) => m.resist?.includes(type.toLowerCase()));

/** The heroes' effects that end with the fight, by name. */
export const fightEffects = (c: Character) => c.effects.filter((e) => e.mods?.endsWithFight).map((e) => e.name);
