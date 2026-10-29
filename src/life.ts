import { checkModifier, type Character } from './rules.ts';
import type { CharacterPatch, GameEvent, GameState } from './state.ts';

export const UNCONSCIOUS = 'Unconscious';

const NO_SAVES = { successes: 0, failures: 0 };

export const isDown = (c: Character): boolean => c.status !== 'up';

const withCondition = (c: Character, on: boolean): Character =>
  ({ ...c, conditions: on ? [...new Set([...c.conditions, UNCONSCIOUS])] : c.conditions.filter((x) => x !== UNCONSCIOUS) });

export function wakeUp(c: Character, hp: number): Character {
  if (c.status === 'dead') return c;
  return withCondition({ ...c, status: 'up', deathSaves: { ...NO_SAVES }, hp: Math.max(c.hp, hp) }, false);
}

const addFailures = (c: Character, n: number): Character =>
  ({ ...c, deathSaves: { ...c.deathSaves, failures: Math.min(3, c.deathSaves.failures + n) } });

/** `after` is the sheet with the raw HP change already applied. */
export function applyHpChange(before: Character, after: Character, p: CharacterPatch): Character {
  if (before.status === 'dead') {
    if (!p.revive) return { ...after, hp: 0 };
    return wakeUp({ ...after, status: 'up' }, Math.max(1, after.hp));
  }
  if (before.status === 'up') {
    if (before.hp > 0 && after.hp === 0) return withCondition({ ...after, status: 'dying', deathSaves: { ...NO_SAVES } }, true);
    return after;
  }
  if (after.hp > 0) return wakeUp(after, after.hp);
  if (p.stabilize && before.status === 'dying') return { ...after, status: 'stable', deathSaves: { ...NO_SAVES } };
  if ((p.hpDelta ?? 0) < 0 && (before.status === 'dying' || before.status === 'stable')) {
    return addFailures({ ...after, status: 'dying' }, p.critical ? 2 : 1);
  }
  return after;
}

export function applyDeathSave(c: Character, face: number): Character {
  if (c.status !== 'dying') return c;
  if (face === 20) return wakeUp(c, 1);
  if (face === 1) return addFailures(c, 2);
  if (face < 10) return addFailures(c, 1);
  const successes = c.deathSaves.successes + 1;
  return { ...c, deathSaves: { ...c.deathSaves, successes }, status: successes >= 3 ? 'stable' : 'dying' };
}

/**
 * Concentration saves the engine owes after an event: a hero keeping a spell up who took damage
 * rolls a CON save against DC 10 or half the damage, whichever is higher.
 */
export function planConcentration(before: GameState, after: GameState): GameEvent[] {
  return after.characters.flatMap((c) => {
    const was = before.characters.find((x) => x.id === c.id);
    const lost = was ? was.hp + was.tempHp - (c.hp + c.tempHp) : 0;
    const holding = after.characters.some((x) => x.effects.some((e) => e.by === c.id));
    if (lost <= 0 || c.status !== 'up' || !holding) return [];
    return [{ type: 'roll_requested', roll: {
      rollId: `conc-${c.id}-${after.seq}`, characterId: c.id, label: 'Concentration', dice: '1d20',
      modifier: checkModifier(c, 'con save').modifier, advantage: 'none', dc: Math.max(10, Math.floor(lost / 2)), hideDc: true, purpose: 'concentration',
    } }];
  });
}
