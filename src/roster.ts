import { z } from 'zod';

export type Side = 'enemy' | 'neutral' | 'ally';

export interface Presence {
  id: string;
  name: string;
  groupId: string;
  side: Side;
  description: string;
  hp?: number;
  maxHp?: number;
  ac?: number;
  initiativeBonus?: number;
  conditions: string[];
  notes: string;
  defeated: boolean;
}

export interface PresencePatch {
  hpDelta?: number;
  hp?: number;
  maxHp?: number;
  ac?: number;
  side?: Side;
  description?: string;
  addConditions?: string[];
  removeConditions?: string[];
  notes?: string;
  defeated?: boolean;
}

export type HealthWord = 'unhurt' | 'hurt' | 'bloodied' | 'nearDeath' | 'defeated';

export interface PresenceSpec {
  name: string;
  side: Side;
  description?: string;
  hp?: number;
  ac?: number;
  initiativeBonus?: number;
  notes?: string;
}

export function healthWord(p: Presence): HealthWord | undefined {
  if (p.defeated) return 'defeated';
  if (p.hp === undefined || p.maxHp === undefined) return undefined;
  if (p.hp <= 0) return 'defeated';
  if (p.hp >= p.maxHp) return 'unhurt';
  const ratio = p.hp / p.maxHp;
  if (ratio > 0.5) return 'hurt';
  if (ratio > 0.25) return 'bloodied';
  return 'nearDeath';
}

export function applyPresencePatch(p: Presence, patch: PresencePatch): Presence {
  const next: Presence = { ...p, conditions: [...p.conditions] };
  if (patch.maxHp !== undefined) next.maxHp = patch.maxHp;
  if (patch.hp !== undefined) next.hp = patch.hp;
  // A creature that needs no HP (a shopkeeper) has none to lose.
  if (patch.hpDelta !== undefined && next.hp !== undefined) next.hp += patch.hpDelta;
  const touchedHp = patch.hp !== undefined || patch.hpDelta !== undefined || patch.maxHp !== undefined;
  if (next.hp !== undefined) {
    next.hp = Math.max(0, next.maxHp === undefined ? next.hp : Math.min(next.maxHp, next.hp));
    // HP only decides defeat at 0: a creature that surrendered or fled stays defeated when hit,
    // and only healing from 0 brings one back.
    if (touchedHp && next.hp === 0) next.defeated = true;
    else if (touchedHp && p.hp === 0) next.defeated = false;
  }
  if (patch.ac !== undefined) next.ac = patch.ac;
  if (patch.side !== undefined) next.side = patch.side;
  if (patch.description !== undefined) next.description = patch.description;
  for (const c of patch.addConditions ?? []) if (!next.conditions.includes(c)) next.conditions.push(c);
  next.conditions = next.conditions.filter((c) => !(patch.removeConditions ?? []).includes(c));
  if (patch.notes !== undefined) next.notes = patch.notes;
  if (patch.defeated !== undefined) next.defeated = patch.defeated;
  return next;
}

/** The only shape of a creature that players ever receive. */
export function publicPresence(p: Presence) {
  return { id: p.id, name: p.name, groupId: p.groupId, side: p.side, description: p.description, conditions: p.conditions, defeated: p.defeated, health: healthWord(p) };
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'creature';

/**
 * `reserved` are ids that must not be handed out again even though nobody in `existing` has them,
 * e.g. groups still in the turn order after leaving the scene.
 */
export function newPresences(existing: Presence[], spec: PresenceSpec, count: number, reserved: Iterable<string> = []): Presence[] {
  const taken = new Set([...existing.flatMap((p) => [p.id, p.groupId]), ...reserved]);
  const base = slug(spec.name);
  const ids: string[] = [];
  if (count === 1 && !taken.has(base)) ids.push(base);
  else for (let n = 1; ids.length < count; n++) if (!taken.has(`${base}-${n}`)) ids.push(`${base}-${n}`);
  return ids.map((id) => ({
    id,
    name: spec.name,
    groupId: ids[0],
    side: spec.side,
    description: spec.description ?? '',
    hp: spec.hp,
    maxHp: spec.hp,
    ac: spec.ac,
    initiativeBonus: spec.initiativeBonus,
    conditions: [],
    notes: spec.notes ?? '',
    defeated: false,
  }));
}

export function findPresence(present: Presence[], idOrName: string): Presence {
  const q = idOrName.trim().toLowerCase();
  const byId = present.find((p) => p.id.toLowerCase() === q);
  if (byId) return byId;
  const named = present.filter((p) => !p.defeated && p.name.toLowerCase() === q);
  if (named.length === 1) return named[0];
  if (named.length > 1) throw new Error(`Several creatures are called ${named[0].name}: ${named.map((p) => p.id).join(', ')}. Use the id.`);
  throw new Error(`No creature "${idOrName}" in the scene. Present: ${present.map((p) => p.id).join(', ') || 'nobody'}.`);
}

/** Input shape shared by `set_scene.present` and `add_to_scene`. */
export const presenceSpec = z.object({
  name: z.string().min(1).describe('Shown to players, no number: "Goblin".'),
  side: z.enum(['enemy', 'neutral', 'ally']),
  description: z.string().optional().describe('Shown to players when they click the card.'),
  hp: z.number().int().min(1).optional().describe('DM-only. Leave out for creatures that need none.'),
  ac: z.number().int().optional().describe('DM-only.'),
  initiative_bonus: z.number().int().optional().describe('DM-only.'),
  notes: z.string().optional().describe('DM-only.'),
  count: z.number().int().min(1).max(30).default(1).describe('Several identical creatures, each with its own HP.'),
});

export function toSpec(a: z.infer<typeof presenceSpec>): PresenceSpec {
  return { name: a.name, side: a.side, description: a.description, hp: a.hp, ac: a.ac, initiativeBonus: a.initiative_bonus, notes: a.notes };
}

/** "Goblin ×2, Captive priest" */
export function stillPresent(present: Presence[]): string {
  const counts = new Map<string, number>();
  for (const p of present) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
  return [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(', ');
}
