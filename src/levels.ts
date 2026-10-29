// Levels 2–5 for every class: what the rules give (HP, proficiency, features, uses, spell slots)
// and the few real choices (spells, ability scores, the bard's skills). `levelUp` resolves a level
// into the hero's new numbers, which the event stores, so replays never depend on this table.

import { pactSlotLevel, resourcesAt, type Resource } from './resources.ts';
import { ABILITIES, CLASSES, mod, RACES, SKILLS, type Ability, type Abilities, type Character, type Feature } from './rules.ts';
import { findSpell, SPELLS, type Spell } from './spells.ts';

export const MAX_LEVEL = 5;
/** XP needed to reach each level (index = level). */
export const XP_FOR_LEVEL = [0, 0, 300, 900, 2700, 6500];

export const proficiencyAt = (level: number) => 2 + Math.floor((level - 1) / 4);
export const canLevel = (c: Character) => c.level < MAX_LEVEL && c.xp >= XP_FOR_LEVEL[c.level + 1];

const f = (name: string, text: string, resourceId?: string): Feature => ({ name, text, source: 'class', ...(resourceId ? { resourceId } : {}) });
const EXTRA_ATTACK = f('Extra Attack', 'When you take the Attack action, you attack twice.');

/** New class features by hero level. */
const FEATURES: Record<string, Record<number, Feature[]>> = {
  barbarian: {
    2: [f('Reckless Attack', 'On your first attack in a turn: advantage on STR melee attacks this turn, but attacks against you have advantage until your next turn.'),
      f('Danger Sense', 'Advantage on DEX saves against effects you can see, such as traps and spells.')],
    3: [f('Frenzy', 'Path of the Berserker: while raging you can make one melee weapon attack as a bonus action each turn; when the rage ends you are exhausted.', 'rage')],
    5: [EXTRA_ATTACK, f('Fast Movement', '+10 ft speed without heavy armour (already counted).')],
  },
  bard: {
    2: [f('Jack of All Trades', 'Add half your proficiency bonus to ability checks without proficiency (already counted).'),
      f('Song of Rest', 'During a short rest, allies who spend hit dice regain extra hit points.')],
    3: [f('Cutting Words', 'College of Lore. Reaction: spend a Bardic Inspiration to subtract the die from a creature\'s attack, check or damage roll.', 'bardic-inspiration')],
    5: [f('Font of Inspiration', 'Bardic Inspiration now comes back after a short rest too.')],
  },
  cleric: {
    2: [f('Channel Divinity', 'Once per short rest: Turn Undead (undead within 30 ft that fail a WIS save flee for a minute) or Preserve Life (share healing among creatures within 30 ft, up to half their max HP).', 'channel-divinity')],
    5: [f('Destroy Undead', 'Weak undead that fail against your Turn Undead are destroyed outright.')],
  },
  druid: {
    2: [f('Wild Shape', 'Action: turn into a beast you have seen, for up to half your level in hours. Its HP protect yours.', 'wild-shape'),
      f('Circle of the Land: Forest', 'Forest magic: Barkskin and Spider Climb at level 3, Call Lightning and Plant Growth at level 5, always known.'),
      f('Natural Recovery', 'Once a day during a short rest, regain spent spell slots of combined level up to half your level.')],
  },
  fighter: {
    2: [f('Action Surge', 'Once per short rest, take one extra action on your turn.', 'action-surge')],
    3: [f('Improved Critical', 'Champion: your weapon attacks are critical hits on a 19 or 20.')],
    5: [EXTRA_ATTACK],
  },
  monk: {
    2: [f('Ki', 'Flurry of Blows (two unarmed strikes as a bonus action), Patient Defense (Dodge as a bonus action) or Step of the Wind (Dash or Disengage as a bonus action): 1 ki each.', 'ki'),
      f('Unarmored Movement', '+10 ft speed without armour or shield (already counted).')],
    3: [f('Open Hand Technique', 'Way of the Open Hand: a Flurry of Blows hit can knock the target prone, push it 15 ft or take its reaction.'),
      f('Deflect Missiles', 'Reaction: reduce the damage of a ranged weapon hit; at 0 you catch it and can throw it back for 1 ki.')],
    4: [f('Slow Fall', 'Reaction: reduce falling damage.')],
    5: [EXTRA_ATTACK, f('Stunning Strike', 'When you hit with a melee weapon, spend 1 ki: the target is stunned until the end of your next turn unless it saves.', 'ki')],
  },
  paladin: {
    2: [f('Fighting Style: Defense', '+1 AC while wearing armour (already counted).'),
      f('Divine Smite', 'When you hit with a melee weapon, spend a spell slot for extra radiant damage: more with a higher slot, and against undead and fiends.')],
    3: [f('Divine Health', 'You are immune to disease.'),
      f('Sacred Oath: Devotion', 'Channel Divinity once per short rest: Sacred Weapon (add CHA to your weapon\'s attack rolls for a minute) or Turn the Unholy (fiends and undead that fail a WIS save flee).', 'channel-divinity')],
    5: [EXTRA_ATTACK],
  },
  ranger: {
    2: [f('Fighting Style: Archery', '+2 to hit with ranged weapons (already counted).')],
    3: [f('Colossus Slayer', 'Hunter: once per turn, extra damage when you hit a creature that is already hurt.'),
      f('Primeval Awareness', 'Spend a spell slot to sense aberrations, celestials, dragons, elementals, fey, fiends and undead within a mile.')],
    5: [EXTRA_ATTACK],
  },
  rogue: {
    2: [f('Cunning Action', 'Bonus action each turn: Dash, Disengage or Hide.')],
    3: [f('Fast Hands', 'Thief: Cunning Action can also be a Sleight of Hand check, using thieves\' tools or using an object.'),
      f('Second-Story Work', 'Thief: climbing costs no extra movement, and your running jumps go further.')],
    5: [f('Uncanny Dodge', 'Reaction: when an attacker you can see hits you, halve the damage.')],
  },
  sorcerer: {
    2: [f('Font of Magic', 'Turn sorcery points into spell slots, or spell slots into points, as a bonus action.', 'sorcery-points')],
    3: [f('Metamagic', 'Spend sorcery points to change a spell: Quickened (2 points: an action spell as a bonus action) or Twinned (points = spell level: a one-target spell hits a second creature).', 'sorcery-points')],
  },
  warlock: {
    2: [f('Eldritch Invocation: Agonizing Blast', 'Add CHA to Eldritch Blast damage (already counted).'),
      f('Eldritch Invocation: Armor of Shadows', 'Cast Mage Armor on yourself at will, without a spell slot.')],
    3: [f('Pact of the Tome', 'A Book of Shadows with three more cantrips: Guidance, Light and Sacred Flame.')],
    5: [f("Eldritch Invocation: Devil's Sight", 'You see normally in darkness, even magical darkness, up to 120 ft.')],
  },
  wizard: {
    2: [f('Evocation Savant', 'School of Evocation: copying evocation spells into your spellbook takes half the time and gold.'),
      f('Sculpt Spells', 'When you cast an evocation spell, up to 1 + its level creatures you pick are spared: no damage and an automatic save.')],
  },
};

/** Spells that come with the level and don't count as picks: domain, circle and oath spells, the Tome's cantrips. */
const AUTO_SPELLS: Record<string, Record<number, string[]>> = {
  cleric: { 3: ['lesser-restoration', 'spiritual-weapon'], 5: ['beacon-of-hope', 'revivify'] },
  druid: { 3: ['barkskin', 'spider-climb'], 5: ['call-lightning', 'plant-growth'] },
  paladin: { 3: ['protection-from-evil-and-good', 'sanctuary'], 5: ['lesser-restoration', 'zone-of-truth'] },
  warlock: { 3: ['guidance', 'light', 'sacred-flame'] },
};

const SPEED: Record<string, Record<number, number>> = { monk: { 2: 10 }, barbarian: { 5: 10 } };

const KNOWN = { 2: 1, 3: 1, 4: 1, 5: 1 };
const PREPARED = { 2: 2, 3: 2, 4: 2, 5: 2 };
const HALF = { 2: 2, 3: 1, 5: 1 };
/** New spells to pick at each level. */
const SPELL_PICKS: Record<string, Record<number, number>> = {
  bard: KNOWN, sorcerer: KNOWN, warlock: KNOWN, cleric: PREPARED, druid: PREPARED, wizard: PREPARED, paladin: HALF, ranger: HALF,
};
const CANTRIP_PICKS: Record<string, Record<number, number>> = {
  bard: { 4: 1 }, cleric: { 4: 1 }, sorcerer: { 4: 1 }, warlock: { 4: 1 }, wizard: { 4: 1 }, druid: { 2: 1, 4: 1 },
};

/**
 * Each class's spell list, best picks first: what a player who doesn't want to choose gets.
 * Cantrips and levelled spells mixed; the spell's own level decides when it can be picked.
 */
const CLASS_SPELLS: Record<string, string[]> = {
  wizard: ['shocking-grasp', 'ray-of-frost', 'minor-illusion', 'prestidigitation', 'acid-splash', 'chill-touch', 'poison-spray', 'message', 'mending', 'dancing-lights', 'true-strike',
    'thunderwave', 'chromatic-orb', 'feather-fall', 'disguise-self', 'comprehend-languages', 'expeditious-retreat', 'charm-person', 'fog-cloud',
    'misty-step', 'scorching-ray', 'hold-person', 'invisibility', 'web', 'mirror-image', 'shatter', 'blur', 'darkness', 'suggestion', 'flaming-sphere', 'magic-weapon', 'spider-climb', 'darkvision', 'blindness-deafness',
    'fireball', 'counterspell', 'haste', 'fly', 'lightning-bolt', 'dispel-magic', 'hypnotic-pattern', 'fear', 'stinking-cloud', 'sleet-storm', 'remove-curse', 'tongues'],
  sorcerer: ['shocking-grasp', 'mage-hand', 'minor-illusion', 'acid-splash', 'chill-touch', 'poison-spray', 'message', 'mending', 'dancing-lights', 'true-strike',
    'shield', 'sleep', 'burning-hands', 'thunderwave', 'charm-person', 'feather-fall', 'disguise-self', 'fog-cloud', 'mage-armor', 'expeditious-retreat', 'comprehend-languages', 'detect-magic',
    'misty-step', 'scorching-ray', 'hold-person', 'invisibility', 'mirror-image', 'shatter', 'web', 'blur', 'suggestion', 'darkness', 'enhance-ability', 'spider-climb', 'darkvision', 'blindness-deafness',
    'fireball', 'counterspell', 'haste', 'lightning-bolt', 'fly', 'hypnotic-pattern', 'fear', 'stinking-cloud', 'sleet-storm', 'dispel-magic', 'daylight', 'tongues'],
  warlock: ['mage-hand', 'chill-touch', 'prestidigitation', 'poison-spray', 'true-strike',
    'hellish-rebuke', 'burning-hands', 'command', 'charm-person', 'comprehend-languages', 'expeditious-retreat',
    'misty-step', 'scorching-ray', 'hold-person', 'invisibility', 'shatter', 'mirror-image', 'suggestion', 'darkness', 'spider-climb', 'blindness-deafness',
    'fireball', 'counterspell', 'hypnotic-pattern', 'fly', 'fear', 'stinking-cloud', 'dispel-magic', 'remove-curse', 'tongues'],
  bard: ['mage-hand', 'light', 'prestidigitation', 'message', 'dancing-lights', 'mending', 'true-strike',
    'sleep', 'faerie-fire', 'cure-wounds', 'heroism', 'disguise-self', 'feather-fall', 'longstrider', 'comprehend-languages', 'detect-magic', 'speak-with-animals',
    'hold-person', 'invisibility', 'shatter', 'heat-metal', 'suggestion', 'lesser-restoration', 'silence', 'enhance-ability', 'blindness-deafness', 'zone-of-truth',
    'hypnotic-pattern', 'fear', 'dispel-magic', 'stinking-cloud', 'tongues'],
  cleric: ['light', 'thaumaturgy', 'resistance', 'mending',
    'guiding-bolt', 'sanctuary', 'command', 'inflict-wounds', 'protection-from-evil-and-good', 'detect-magic',
    'aid', 'hold-person', 'prayer-of-healing', 'silence', 'blindness-deafness', 'enhance-ability', 'zone-of-truth',
    'spirit-guardians', 'mass-healing-word', 'dispel-magic', 'daylight', 'remove-curse', 'tongues'],
  druid: ['shillelagh', 'guidance', 'resistance', 'poison-spray', 'mending',
    'healing-word', 'thunderwave', 'fog-cloud', 'speak-with-animals', 'longstrider', 'charm-person', 'detect-magic',
    'moonbeam', 'pass-without-trace', 'spike-growth', 'heat-metal', 'flaming-sphere', 'hold-person', 'lesser-restoration', 'enhance-ability', 'darkvision',
    'conjure-animals', 'dispel-magic', 'sleet-storm', 'daylight'],
  paladin: ['bless', 'cure-wounds', 'shield-of-faith', 'divine-favor', 'heroism', 'command', 'detect-magic',
    'aid', 'magic-weapon'],
  ranger: ['hunters-mark', 'cure-wounds', 'goodberry', 'fog-cloud', 'longstrider', 'speak-with-animals', 'detect-magic',
    'pass-without-trace', 'spike-growth', 'barkskin', 'lesser-restoration', 'darkvision', 'silence'],
};

const BARD_SKILLS = ['Perception', 'Stealth', 'Deception', 'Investigation', 'Athletics', 'Acrobatics'];
const BARD_EXPERTISE = ['Persuasion', 'Performance', 'Perception', 'Insight'];

/** The highest spell level a hero can cast at a level. */
export function maxSpellLevel(classId: string, level: number): number {
  const kind = CLASSES.find((c) => c.id === classId)?.spellcasting?.kind;
  if (kind === 'full') return Math.min(3, Math.ceil(level / 2));
  if (kind === 'pact') return pactSlotLevel(level);
  if (kind === 'half') return level >= 5 ? 2 : level >= 2 ? 1 : 0;
  return 0;
}

/** HP for one more level: the hit die's average, never less than 1. */
function hpPerLevel(c: Character, abilities: Abilities): number {
  const hitDie = CLASSES.find((x) => x.id === c.classId)!.hitDie;
  const extra = (c.raceId === 'dwarf' ? 1 : 0) + (c.classId === 'sorcerer' ? 1 : 0);
  return Math.max(1, hitDie / 2 + 1 + mod(abilities.con)) + extra;
}

/** The class's own armour formula, with a paladin's Defense on top. */
function classAc(c: Character, abilities: Abilities, features: Feature[]): number {
  const m = Object.fromEntries(ABILITIES.map((a) => [a, mod(abilities[a])])) as Abilities;
  const cls = CLASSES.find((x) => x.id === c.classId)!;
  const defense = c.classId !== 'fighter' && features.some((x) => x.name === 'Fighting Style: Defense') ? 1 : 0;
  return cls.ac(m) + defense;
}

export interface LevelChoices {
  /** Ability score increase at level 4: +2 to one, or +1 to two. */
  asi?: Partial<Record<Ability, number>>;
  spells?: string[];
  cantrips?: string[];
  skills?: string[];
  expertise?: string[];
}

interface Pick<T> { count: number; from: T[]; recommended: string[] }

export interface LevelOptions {
  level: number;
  /** HP gained, before any CON increase. */
  hp: number;
  proficiency: number;
  speed: number;
  features: Feature[];
  /** Spells that come automatically. */
  spells: Spell[];
  /** Uses and spell slots at the new level. */
  resources: Resource[];
  choices: {
    asi?: { points: number; recommended: Partial<Record<Ability, number>> };
    cantrips?: Pick<Spell>;
    spells?: Pick<Spell>;
    skills?: Pick<string>;
    expertise?: Pick<string>;
  };
}

function recommendedAsi(c: Character): Partial<Record<Ability, number>> {
  const [main, second] = CLASSES.find((x) => x.id === c.classId)!.priority;
  const score = c.abilities[main];
  if (score >= 20) return { [second]: 2 };
  if (score % 2 === 1 || score === 19) return { [main]: 1, [second]: 1 };
  return { [main]: 2 };
}

function spellPick(c: Character, level: number, count: number, cantrip: boolean, auto: Spell[]): Pick<Spell> | undefined {
  if (!count) return undefined;
  const top = maxSpellLevel(c.classId, level);
  const known = new Set([...c.spells, ...auto].map((s) => s.id));
  const list = (CLASS_SPELLS[c.classId] ?? []).map((id) => findSpell(id)!)
    .filter((s) => !known.has(s.id) && (cantrip ? s.level === 0 : s.level >= 1 && s.level <= top));
  // Newest spell level first: that's what levelling up is for.
  const from = [...list].sort((a, b) => b.level - a.level);
  return from.length ? { count: Math.min(count, from.length), from, recommended: from.slice(0, count).map((s) => s.id) } : undefined;
}

function skillPick(from: string[], count: number, preferred: string[]): Pick<string> {
  const recommended = [...preferred.filter((x) => from.includes(x)), ...from.filter((x) => !preferred.includes(x))].slice(0, count);
  return { count, from, recommended };
}

/** What the next level brings and what is left to choose. */
export function levelOptions(c: Character): LevelOptions {
  if (c.level >= MAX_LEVEL) throw new Error(`${c.name} is level ${c.level}; levels above ${MAX_LEVEL} aren't supported yet.`);
  const level = c.level + 1;
  const spells = (AUTO_SPELLS[c.classId]?.[level] ?? []).map((id) => ({ ...findSpell(id)! })).filter((s) => !c.spells.some((x) => x.id === s.id));
  const choices: LevelOptions['choices'] = {};
  if (level === 4) choices.asi = { points: 2, recommended: recommendedAsi(c) };
  const cantrips = spellPick(c, level, CANTRIP_PICKS[c.classId]?.[level] ?? 0, true, spells);
  if (cantrips) choices.cantrips = cantrips;
  const picks = spellPick(c, level, SPELL_PICKS[c.classId]?.[level] ?? 0, false, spells);
  if (picks) choices.spells = picks;
  if (c.classId === 'bard' && level === 3) {
    choices.skills = skillPick(Object.keys(SKILLS).filter((s) => !c.skills.includes(s)), 3, BARD_SKILLS);
    // Expertise may go to a skill picked in the same level up.
    choices.expertise = skillPick(Object.keys(SKILLS).filter((s) => !c.expertise.includes(s)), 2, BARD_EXPERTISE.filter((s) => c.skills.includes(s)));
  }
  return {
    level,
    hp: hpPerLevel(c, c.abilities),
    proficiency: proficiencyAt(level),
    speed: SPEED[c.classId]?.[level] ?? 0,
    features: (FEATURES[c.classId]?.[level] ?? []).filter((x) => !c.features.some((y) => y.name === x.name)).map((x) => ({ ...x, level })),
    spells,
    resources: resourcesAt(c, level),
    choices,
  };
}

/** Fills the choices the player left out with the recommended picks. */
export function withRecommended(o: LevelOptions, given: LevelChoices = {}): LevelChoices {
  const ch = o.choices;
  return {
    ...(ch.asi ? { asi: given.asi ?? ch.asi.recommended } : {}),
    ...(ch.cantrips ? { cantrips: given.cantrips ?? ch.cantrips.recommended } : {}),
    ...(ch.spells ? { spells: given.spells ?? ch.spells.recommended } : {}),
    ...(ch.skills ? { skills: given.skills ?? ch.skills.recommended } : {}),
    ...(ch.expertise ? { expertise: given.expertise ?? ch.expertise.recommended } : {}),
  };
}

export const needsChoices = (o: LevelOptions) => Object.keys(o.choices).length > 0;

/** A level's result: the hero's new numbers. The event stores this. */
export interface LevelGains {
  level: number;
  hpGain: number;
  maxHp: number;
  proficiencyBonus: number;
  abilities: Abilities;
  ac: number;
  speed: number;
  skills: string[];
  expertise: string[];
  features: Feature[];
  spells: Spell[];
  resources: Resource[];
}

const findSpells = (ids: string[], pick: Pick<Spell>, what: string) => {
  if (ids.length !== pick.count) throw new Error(`Pick ${pick.count} ${what}; got ${ids.length}.`);
  if (new Set(ids).size !== ids.length) throw new Error(`The same ${what.replace(/s$/, '')} twice.`);
  return ids.map((id) => {
    const s = pick.from.find((x) => x.id === id || x.name.toLowerCase() === id.trim().toLowerCase());
    if (!s) throw new Error(`"${id}" isn't one of the ${what} to pick from: ${pick.from.map((x) => x.name).join(', ')}.`);
    return { ...s };
  });
};

const findSkills = (names: string[], pick: Pick<string>, what: string) => {
  if (names.length !== pick.count) throw new Error(`Pick ${pick.count} ${what}; got ${names.length}.`);
  return names.map((n) => {
    const s = pick.from.find((x) => x.toLowerCase() === n.trim().toLowerCase());
    if (!s) throw new Error(`"${n}" can't be picked for ${what}. Choose from: ${pick.from.join(', ')}.`);
    return s;
  });
};

/** Resolves the next level with the given choices (all of them needed; see withRecommended). */
export function levelUp(c: Character, choices: LevelChoices): LevelGains {
  const o = levelOptions(c);
  const ch = o.choices;

  const abilities = { ...c.abilities };
  if (ch.asi) {
    const asi = choices.asi ?? {};
    const entries = Object.entries(asi).filter(([, v]) => v) as [Ability, number][];
    const points = entries.reduce((n, [, v]) => n + v, 0);
    if (points !== 2 || entries.some(([a, v]) => !ABILITIES.includes(a) || ![1, 2].includes(v))) {
      throw new Error('Ability score increase: +2 to one ability, or +1 to two.');
    }
    for (const [a, v] of entries) {
      if (abilities[a] + v > 20) throw new Error(`${a.toUpperCase()} can't go above 20.`);
      abilities[a] += v;
    }
  }

  const cantrips = ch.cantrips ? findSpells(choices.cantrips ?? [], ch.cantrips, 'cantrips') : [];
  const spells = ch.spells ? findSpells(choices.spells ?? [], ch.spells, 'spells') : [];
  const skills = ch.skills ? findSkills(choices.skills ?? [], ch.skills, 'new skills') : [];
  let expertise: string[] = [];
  if (ch.expertise) {
    expertise = findSkills(choices.expertise ?? [], ch.expertise, 'Expertise');
    const proficient = [...c.skills, ...skills];
    const bad = expertise.find((x) => !proficient.includes(x));
    if (bad) throw new Error(`Expertise needs proficiency: ${bad} isn't one of ${c.name}'s skills.`);
    if (new Set(expertise).size !== expertise.length) throw new Error('Expertise in the same skill twice.');
  }

  const bardExpertise = expertise.length ? [f('Bardic Expertise', `Double proficiency in ${expertise.join(' and ')}.`)].map((x) => ({ ...x, level: o.level })) : [];
  // Starting features get today's wording, in case it changed since the hero was made.
  const defaults = [...(CLASSES.find((x) => x.id === c.classId)?.features ?? []), ...(RACES.find((x) => x.id === c.raceId)?.traits ?? [])];
  const current = c.features.map((x) => ({ ...x, text: defaults.find((d) => d.name === x.name)?.text ?? x.text }));
  const features = [...current, ...o.features, ...bardExpertise];
  // A CON increase counts for every level already gained, too.
  const hpGain = hpPerLevel(c, abilities) + (mod(abilities.con) - mod(c.abilities.con)) * c.level;
  const handMadeAc = c.ac !== classAc(c, c.abilities, c.features);
  const ac = handMadeAc ? c.ac + classAc(c, c.abilities, features) - classAc(c, c.abilities, c.features) : classAc(c, abilities, features);

  return {
    level: o.level,
    hpGain,
    maxHp: c.maxHp + hpGain,
    proficiencyBonus: o.proficiency,
    abilities,
    ac,
    speed: c.speed + o.speed,
    skills: [...c.skills, ...skills],
    expertise: [...c.expertise, ...expertise],
    features,
    spells: [...c.spells, ...o.spells, ...cantrips, ...spells],
    resources: resourcesAt(c, o.level, abilities),
  };
}

/** Applies a stored level: new numbers, current HP up by what was gained (unless down or dead). */
export function applyLevel(c: Character, g: LevelGains): Character {
  const { hpGain, ...fields } = g;
  return { ...c, ...fields, hp: c.status === 'up' ? Math.min(g.maxHp, c.hp + hpGain) : c.hp, pendingLevel: undefined };
}

/** Numbers some features carry that grow with level, shown on the sheet next to the feature. */
export function featureValue(c: Character, name: string): string | undefined {
  const l = c.level;
  const dc = (a: Ability) => 8 + c.proficiencyBonus + mod(c.abilities[a]);
  switch (name) {
    case 'Sneak Attack': return `${Math.ceil(l / 2)}d6`;
    case 'Martial Arts': return l >= 5 ? '1d6' : '1d4';
    case 'Bardic Inspiration': return l >= 5 ? '1d8' : '1d6';
    case 'Song of Rest': return '1d6';
    case 'Second Wind': return `1d10+${l}`;
    case 'Rage': return '+2';
    case 'Divine Smite': return '2d8';
    case 'Breath Weapon': return l >= 6 ? '3d6' : '2d6';
    case 'Colossus Slayer': return '1d8';
    case 'Channel Divinity': return c.classId === 'cleric' ? `${5 * l} HP` : undefined;
    case 'Wild Shape': return l >= 4 ? 'CR ½' : 'CR ¼';
    case 'Destroy Undead': return 'CR ½';
    case 'Slow Fall': return `−${5 * l}`;
    case 'Deflect Missiles': return `1d10+${mod(c.abilities.dex) + l}`;
    case 'Stunning Strike': case 'Open Hand Technique': return `DC ${dc('wis')}`;
    default: return undefined;
  }
}

/** Spell ids every spell-pick list draws from, for tests. */
export const classSpellIds = (classId: string) => CLASS_SPELLS[classId] ?? [];
export const allSpellIds = () => SPELLS.map((s) => s.id);
