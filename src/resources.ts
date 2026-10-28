import type { Abilities, Character } from './rules.ts';
import { CLASSES, defaultSpells, splitItemName, upgradeFeatures } from './rules.ts';

export type Recharge = 'short' | 'long';

export interface Resource {
  id: string;
  name: string;
  max: number;
  used: number;
  recharge: Recharge;
  unit?: 'hp';
  /** Pact slots: the level every slot is cast at. */
  slotLevel?: number;
}

const res = (id: string, name: string, max: number, recharge: Recharge, extra: Partial<Resource> = {}): Resource =>
  ({ id, name, max, used: 0, recharge, ...extra });

const ORDINAL = ['', '1st', '2nd', '3rd'];
/** Spell slots per hero level, 1st level first. */
const FULL_SLOTS = [[], [2], [3], [4, 2], [4, 3], [4, 3, 2]];
const HALF_SLOTS = [[], [], [2], [3], [3], [4, 2]];

const slots = (table: number[][], level: number) =>
  table[level].map((n, i) => res(`spell-slots-${i + 1}`, `Spell slots (${ORDINAL[i + 1]})`, n, 'long'));

/** The level of spell a warlock's pact slots are cast at. */
export const pactSlotLevel = (level: number) => Math.min(3, Math.ceil(level / 2));
const chaMod = (a: Abilities) => Math.max(1, Math.floor((a.cha - 10) / 2));

const CLASS_RESOURCES: Record<string, (a: Abilities, level: number) => Resource[]> = {
  fighter: (_, l) => [res('second-wind', 'Second Wind', 1, 'short'), ...(l >= 2 ? [res('action-surge', 'Action Surge', 1, 'short')] : [])],
  barbarian: (_, l) => [res('rage', 'Rage', l >= 3 ? 3 : 2, 'long')],
  wizard: (_, l) => [...slots(FULL_SLOTS, l), res('arcane-recovery', 'Arcane Recovery', 1, 'long')],
  sorcerer: (_, l) => [...slots(FULL_SLOTS, l), ...(l >= 2 ? [res('sorcery-points', 'Sorcery points', l, 'long')] : [])],
  cleric: (_, l) => [...slots(FULL_SLOTS, l), ...(l >= 2 ? [res('channel-divinity', 'Channel Divinity', 1, 'short')] : [])],
  druid: (_, l) => [...slots(FULL_SLOTS, l), ...(l >= 2 ? [res('wild-shape', 'Wild Shape', 2, 'short')] : [])],
  bard: (a, l) => [...slots(FULL_SLOTS, l), res('bardic-inspiration', 'Bardic Inspiration', chaMod(a), l >= 5 ? 'short' : 'long')],
  warlock: (_, l) => [res('pact-slot', `Pact slots (${ORDINAL[pactSlotLevel(l)]})`, l >= 2 ? 2 : 1, 'short', { slotLevel: pactSlotLevel(l) })],
  paladin: (_, l) => [res('lay-on-hands', 'Lay on Hands', 5 * l, 'long', { unit: 'hp' }), ...slots(HALF_SLOTS, l),
    ...(l >= 3 ? [res('channel-divinity', 'Channel Divinity', 1, 'short')] : [])],
  ranger: (_, l) => slots(HALF_SLOTS, l),
  monk: (_, l) => (l >= 2 ? [res('ki', 'Ki points', l, 'short')] : []),
};

export function defaultResources(classId: string, abilities: Abilities, level = 1): Resource[] {
  const hitDie = CLASSES.find((c) => c.id === classId)?.hitDie ?? 8;
  return [...(CLASS_RESOURCES[classId]?.(abilities, level) ?? []), res('hit-dice', `Hit dice (d${hitDie})`, level, 'long')];
}

/** The resources a hero has at a new level: new maximums, spent uses kept, anything the DM added kept. */
export function resourcesAt(c: Character, level: number, abilities = c.abilities): Resource[] {
  const fresh = defaultResources(c.classId, abilities, level);
  const old = new Map(c.resources.map((r) => [r.id, r]));
  const out = fresh.map((r) => {
    const was = old.get(r.id);
    return was ? { ...r, used: Math.min(was.used, r.max) } : r;
  });
  return [...out, ...c.resources.filter((r) => !fresh.some((x) => x.id === r.id))];
}

/** Brings characters from older events up to date: resources, life status, structured features, spells. */
export function withDefaults(c: Character): Character {
  return {
    ...c,
    // Fighters used to be made with AC 18, missing their Defense style's +1.
    ac: c.classId === 'fighter' && c.ac === 18 && c.acNote === 'Chain mail + shield' ? 19 : c.ac,
    resources: c.resources ?? defaultResources(c.classId, c.abilities, c.level),
    features: upgradeFeatures(c.raceId, c.classId, c.features),
    spells: c.spells ?? defaultSpells(c.raceId, c.classId),
    effects: c.effects ?? [],
    inventory: c.inventory.map((i) => (i.note !== undefined ? i : { ...i, ...splitItemName(i.name) })),
    expertise: c.expertise ?? [...(CLASSES.find((x) => x.id === c.classId)?.expertise ?? [])],
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
  // Spell and feature effects last minutes or hours; a night's sleep ends them all.
  return kind === 'long' ? { ...c, resources, hp: c.maxHp, effects: [] } : { ...c, resources };
}
