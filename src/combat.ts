import { mod } from './rules.ts';
import type { GameEvent, GameState } from './state.ts';

export type CombatRef = { kind: 'hero'; id: string } | { kind: 'group'; groupId: string };

export interface CombatEntry {
  ref: CombatRef;
  /** null while a hero's initiative roll is pending. */
  initiative: number | null;
  /** Hero DEX modifier or group initiative bonus. */
  tiebreak: number;
}

/** `round === 0` means initiative is still being gathered. */
export interface Combat {
  round: number;
  turn: number;
  order: CombatEntry[];
}

export const sameRef = (a: CombatRef, b: CombatRef): boolean =>
  a.kind === 'hero' ? b.kind === 'hero' && a.id === b.id : b.kind === 'group' && a.groupId === b.groupId;

export function sortOrder(order: CombatEntry[]): CombatEntry[] {
  const heroFirst = (e: CombatEntry) => (e.ref.kind === 'hero' ? 1 : 0);
  return order
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (b.e.initiative ?? -999) - (a.e.initiative ?? -999) || b.e.tiebreak - a.e.tiebreak || heroFirst(b.e) - heroFirst(a.e) || a.i - b.i)
    .map(({ e }) => e);
}

export function canAct(s: GameState, e: CombatEntry): boolean {
  const { ref } = e;
  if (ref.kind === 'hero') {
    const status = s.characters.find((c) => c.id === ref.id)?.status;
    return status === 'up' || status === 'dying';
  }
  return s.present.some((p) => p.groupId === ref.groupId && !p.defeated);
}

export function currentActor(s: GameState): CombatEntry | undefined {
  if (!s.combat || s.combat.round === 0) return undefined;
  const e = s.combat.order[s.combat.turn];
  return e && canAct(s, e) ? e : undefined;
}

export function entryName(s: GameState, e: CombatEntry): string {
  const { ref } = e;
  if (ref.kind === 'hero') return s.characters.find((c) => c.id === ref.id)?.name ?? ref.id;
  return s.present.find((p) => p.groupId === ref.groupId)?.name ?? ref.groupId;
}

/** Once no hero initiative is pending: sort and begin round 1. */
export function beginIfReady(s: GameState, c: Combat): Combat {
  if (c.round > 0 || c.order.some((e) => e.initiative === null)) return c;
  const order = sortOrder(c.order);
  const turn = order.findIndex((e) => canAct(s, e));
  return { round: 1, turn: Math.max(0, turn), order };
}

/** Where the turn moves next, or undefined when nobody can act. */
export function nextTurn(s: GameState): { round: number; turn: number } | undefined {
  const c = s.combat;
  if (!c || c.round === 0) return undefined;
  const n = c.order.length;
  for (let k = 1; k <= n; k++) {
    const i = c.turn + k;
    if (canAct(s, c.order[i % n])) return { round: c.round + (i >= n ? 1 : 0), turn: i % n };
  }
  return undefined;
}

export function addEntry(c: Combat, entry: CombatEntry): Combat {
  if (c.round === 0) return { ...c, order: [...c.order, entry] };
  const current = c.order[c.turn];
  const order = sortOrder([...c.order, entry]);
  return { ...c, order, turn: current ? order.findIndex((e) => sameRef(e.ref, current.ref)) : 0 };
}

export function heroEntry(s: GameState, heroId: string, initiative: number | null): CombatEntry {
  const hero = s.characters.find((c) => c.id === heroId);
  if (!hero) throw new Error(`No character "${heroId}".`);
  return { ref: { kind: 'hero', id: hero.id }, initiative, tiebreak: mod(hero.abilities.dex) };
}

export function groupEntry(s: GameState, groupId: string, initiative: (bonus: number) => number): CombatEntry {
  const first = s.present.find((p) => p.groupId === groupId);
  if (!first) throw new Error(`No creature group "${groupId}" in the scene.`);
  const bonus = first.initiativeBonus ?? 0;
  return { ref: { kind: 'group', groupId }, initiative: initiative(bonus), tiebreak: bonus };
}

export function planStartCombat(s: GameState, participants: { heroes: string[]; groupIds: string[] }, roll: () => number): GameEvent[] {
  const heroes = participants.heroes.map((id) => heroEntry(s, id, null));  const groups = participants.groupIds.map((g) => groupEntry(s, g, (bonus) => roll() + bonus));
  const asks: GameEvent[] = participants.heroes.map((id, i) => ({
    type: 'roll_requested',
    roll: { rollId: `init-${id}-${s.seq}`, characterId: id, label: 'Initiative', dice: '1d20', modifier: heroes[i].tiebreak, advantage: 'none', hideDc: true, purpose: 'initiative' },
  }));
  return [{ type: 'combat_started', order: [...heroes, ...groups] }, ...asks];
}

export const dyingHeroId = (s: GameState, e: CombatEntry | undefined): string | undefined => {
  const ref = e?.ref;
  return ref?.kind === 'hero' && s.characters.find((c) => c.id === ref.id)?.status === 'dying' ? ref.id : undefined;
};

export const deathSaveRequest = (s: GameState, heroId: string): GameEvent =>
  ({ type: 'roll_requested', roll: { rollId: `death-${heroId}-${s.seq}`, characterId: heroId, label: 'Death save', dice: '1d20', modifier: 0, advantage: 'none', hideDc: true, purpose: 'death_save' } });

export function planNextTurn(s: GameState): GameEvent[] {
  const next = nextTurn(s);
  if (!next) return [];
  const dying = dyingHeroId(s, s.combat!.order[next.turn]);
  return dying ? [{ type: 'turn_advanced' }, deathSaveRequest(s, dying)] : [{ type: 'turn_advanced' }];
}

/** The death save owed when round 1 has just opened on a dying hero. */
export function planRoundStart(before: GameState, after: GameState): GameEvent[] {
  if ((before.combat?.round ?? 0) !== 0 || !after.combat || after.combat.round === 0) return [];
  const dying = dyingHeroId(after, currentActor(after));
  return dying ? [deathSaveRequest(after, dying)] : [];
}
