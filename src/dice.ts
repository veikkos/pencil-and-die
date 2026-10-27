export type Advantage = 'none' | 'advantage' | 'disadvantage';

export interface DiceSpec {
  count: number;
  sides: number;
}

const VALID_SIDES = new Set([4, 6, 8, 10, 12, 20, 100]);

/** Parses "d20", "1d20", "2d6". Modifiers are kept separate on purpose. */
export function parseDice(notation: string): DiceSpec {
  const m = /^\s*(\d*)\s*d\s*(\d+)\s*$/i.exec(notation);
  if (!m) throw new Error(`Invalid dice notation "${notation}". Use e.g. "1d20" or "2d6".`);
  const count = m[1] ? Number(m[1]) : 1;
  const sides = Number(m[2]);
  if (!VALID_SIDES.has(sides)) throw new Error(`d${sides} is not a standard die.`);
  if (count < 1 || count > 20) throw new Error('Roll between 1 and 20 dice at a time.');
  return { count, sides };
}

/** How many physical dice the players must throw. Advantage means two d20s. */
export function physicalDice(spec: DiceSpec, advantage: Advantage): DiceSpec {
  if (advantage !== 'none') {
    if (spec.count !== 1 || spec.sides !== 20) throw new Error('Advantage/disadvantage only applies to a single d20.');
    return { count: 2, sides: 20 };
  }
  return spec;
}

export interface RollOutcome {
  faces: number[];
  kept: number;
  total: number;
}

export function scoreRoll(spec: DiceSpec, advantage: Advantage, modifier: number, faces: number[]): RollOutcome {
  const need = physicalDice(spec, advantage);
  if (faces.length !== need.count) throw new Error(`Expected ${need.count} dice, got ${faces.length}.`);
  for (const f of faces) {
    if (!Number.isInteger(f) || f < 1 || f > need.sides) throw new Error(`A d${need.sides} shows 1–${need.sides}, not ${f}.`);
  }
  const kept =
    advantage === 'advantage' ? Math.max(...faces) :
    advantage === 'disadvantage' ? Math.min(...faces) :
    faces.reduce((a, b) => a + b, 0);
  return { faces, kept, total: kept + modifier };
}

export function virtualRoll(spec: DiceSpec, advantage: Advantage, modifier: number, rng: () => number = Math.random): RollOutcome {
  const need = physicalDice(spec, advantage);
  const faces = Array.from({ length: need.count }, () => 1 + Math.floor(rng() * need.sides));
  return scoreRoll(spec, advantage, modifier, faces);
}
