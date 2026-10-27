import type { Abilities, Character } from './rules.ts';
import { CLASSES } from './rules.ts';

export type Recharge = 'short' | 'long';

export interface Resource {
  id: string;
  name: string;
  max: number;
  used: number;
  recharge: Recharge;
  unit?: 'hp';
}

const res = (id: string, name: string, max: number, recharge: Recharge, unit?: 'hp'): Resource =>
  ({ id, name, max, used: 0, recharge, ...(unit ? { unit } : {}) });
const slots = () => res('spell-slots-1', 'Spell slots (1st)', 2, 'long');

const CLASS_RESOURCES: Record<string, (a: Abilities) => Resource[]> = {
  fighter: () => [res('second-wind', 'Second Wind', 1, 'short')],
  barbarian: () => [res('rage', 'Rage', 2, 'long')],
  wizard: () => [slots(), res('arcane-recovery', 'Arcane Recovery', 1, 'long')],
  sorcerer: () => [slots()],
  cleric: () => [slots()],
  druid: () => [slots()],
  bard: (a) => [slots(), res('bardic-inspiration', 'Bardic Inspiration', Math.max(1, Math.floor((a.cha - 10) / 2)), 'long')],
  warlock: () => [res('pact-slot', 'Pact slot', 1, 'short')],
  paladin: () => [res('lay-on-hands', 'Lay on Hands', 5, 'long', 'hp')],
};

export function defaultResources(classId: string, abilities: Abilities): Resource[] {
  const hitDie = CLASSES.find((c) => c.id === classId)?.hitDie ?? 8;
  return [...(CLASS_RESOURCES[classId]?.(abilities) ?? []), res('hit-dice', `Hit dice (d${hitDie})`, 1, 'long')];
}

/** Fills fields that events written before resources existed don't have. */
export function withDefaults(c: Character): Character {
  return {
    ...c,
    resources: c.resources ?? defaultResources(c.classId, c.abilities),
    status: c.status ?? 'up',
    deathSaves: c.deathSaves ?? { successes: 0, failures: 0 },
  };
}

export function findResource(c: Character, idOrName: string): Resource {
  const key = idOrName.trim().toLowerCase();
  const r = c.resources.find((x) => x.id === key || x.name.toLowerCase() === key);
  if (!r) throw new Error(`${c.name} has no resource "${idOrName}". Resources: ${c.resources.map((x) => x.name).join(', ') || 'none'}`);
  return r;
}

const setResource = (c: Character, id: string, change: (r: Resource) => Resource): Character =>
  ({ ...c, resources: c.resources.map((r) => (r.id === id ? change(r) : r)) });

/** Negative amounts restore. */
export function useResource(c: Character, resourceId: string, amount: number): Character {
  const r = findResource(c, resourceId);
  if (r.used + amount > r.max) throw new Error(`${c.name} has no ${r.name} uses left`);
  if (r.used + amount < 0) throw new Error(`${c.name}: ${r.name} can't restore past max`);
  return setResource(c, r.id, (x) => ({ ...x, used: x.used + amount }));
}

export function restCharacter(c: Character, kind: Recharge): Character {
  const resources = c.resources.map((r) => {
    if (r.recharge === 'short') return { ...r, used: 0 };
    if (kind === 'short') return r;
    if (r.id === 'hit-dice') return { ...r, used: Math.max(0, r.used - Math.max(1, Math.floor(r.max / 2))) };
    return { ...r, used: 0 };
  });
  return kind === 'long' ? { ...c, resources, hp: c.maxHp } : { ...c, resources };
}
