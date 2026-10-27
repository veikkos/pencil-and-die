// A small slice of D&D 5e (SRD) — enough to build a level-1 character from three
// simple choices. The DM (Claude) handles everything beyond that.

import { defaultResources, type Resource } from './resources.ts';

export const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
export type Ability = (typeof ABILITIES)[number];
export type Abilities = Record<Ability, number>;

export const SKILLS: Record<string, Ability> = {
  Acrobatics: 'dex', 'Animal Handling': 'wis', Arcana: 'int', Athletics: 'str',
  Deception: 'cha', History: 'int', Insight: 'wis', Intimidation: 'cha',
  Investigation: 'int', Medicine: 'wis', Nature: 'int', Perception: 'wis',
  Performance: 'cha', Persuasion: 'cha', Religion: 'int', 'Sleight of Hand': 'dex',
  Stealth: 'dex', Survival: 'wis',
};

export interface Race {
  id: string;
  name: string;
  blurb: string;
  bonuses: Partial<Abilities>;
  speed: number;
  traits: string[];
}

export const RACES: Race[] = [
  { id: 'human', name: 'Human', blurb: 'Adaptable and ambitious; a little good at everything.',
    bonuses: { str: 1, dex: 1, con: 1, int: 1, wis: 1, cha: 1 }, speed: 30, traits: ['Extra language'] },
  { id: 'elf', name: 'Elf (High)', blurb: 'Graceful, keen-eyed and long-lived, with a touch of magic.',
    bonuses: { dex: 2, int: 1 }, speed: 30, traits: ['Darkvision 60 ft', 'Keen Senses (Perception)', 'Fey Ancestry', 'Trance', 'One wizard cantrip'] },
  { id: 'dwarf', name: 'Dwarf (Hill)', blurb: 'Stout, stubborn and hard to kill.',
    bonuses: { con: 2, wis: 1 }, speed: 25, traits: ['Darkvision 60 ft', 'Dwarven Resilience (poison)', 'Stonecunning', 'Dwarven Toughness (+1 HP/level)'] },
  { id: 'halfling', name: 'Halfling (Lightfoot)', blurb: 'Small, cheerful and uncannily lucky.',
    bonuses: { dex: 2, cha: 1 }, speed: 25, traits: ['Lucky (reroll natural 1s)', 'Brave', 'Halfling Nimbleness', 'Naturally Stealthy'] },
  { id: 'gnome', name: 'Gnome (Rock)', blurb: 'Curious tinkerers with quick minds.',
    bonuses: { int: 2, con: 1 }, speed: 25, traits: ['Darkvision 60 ft', 'Gnome Cunning', "Artificer's Lore", 'Tinker'] },
  { id: 'half-elf', name: 'Half-Elf', blurb: 'At home in two worlds and charming in both.',
    bonuses: { cha: 2 }, speed: 30, traits: ['Darkvision 60 ft', 'Fey Ancestry', '+1 to two other abilities', 'Two extra skills'] },
  { id: 'half-orc', name: 'Half-Orc', blurb: 'Fierce and enduring; hard to put down.',
    bonuses: { str: 2, con: 1 }, speed: 30, traits: ['Darkvision 60 ft', 'Menacing (Intimidation)', 'Relentless Endurance', 'Savage Attacks'] },
  { id: 'dragonborn', name: 'Dragonborn', blurb: 'Proud draconic folk who breathe elemental fire.',
    bonuses: { str: 2, cha: 1 }, speed: 30, traits: ['Draconic Ancestry (red: fire)', 'Breath Weapon 2d6', 'Damage Resistance (fire)'] },
  { id: 'tiefling', name: 'Tiefling', blurb: 'Touched by the infernal; clever, magnetic, distrusted.',
    bonuses: { cha: 2, int: 1 }, speed: 30, traits: ['Darkvision 60 ft', 'Hellish Resistance (fire)', 'Infernal Legacy (Thaumaturgy)'] },
];

export interface CharClass {
  id: string;
  name: string;
  blurb: string;
  hitDie: number;
  /** Abilities in order of importance for this class. */
  priority: Ability[];
  saves: Ability[];
  skills: string[];
  /** Armour class from equipment, given ability modifiers. */
  ac: (mod: Abilities) => number;
  acNote: string;
  equipment: string[];
  features: string[];
}

const dexCap = (mod: Abilities, cap: number) => Math.min(mod.dex, cap);

export const CLASSES: CharClass[] = [
  { id: 'fighter', name: 'Fighter', blurb: 'Master of weapons and armour. Simple, sturdy, reliable.', hitDie: 10,
    priority: ['str', 'con', 'dex', 'wis', 'cha', 'int'], saves: ['str', 'con'], skills: ['Athletics', 'Perception'],
    ac: () => 18, acNote: 'Chain mail + shield',
    equipment: ['Chain mail', 'Shield', 'Longsword', '2 Handaxes', "Explorer's pack"],
    features: ['Fighting Style: Defense', 'Second Wind (bonus action: heal 1d10 + level, once per rest)'] },
  { id: 'barbarian', name: 'Barbarian', blurb: 'Furious warrior who shrugs off blows.', hitDie: 12,
    priority: ['str', 'con', 'dex', 'wis', 'cha', 'int'], saves: ['str', 'con'], skills: ['Athletics', 'Survival'],
    ac: (m) => 10 + m.dex + m.con, acNote: 'Unarmored Defense (10 + DEX + CON)',
    equipment: ['Greataxe', '2 Handaxes', "Explorer's pack", '4 Javelins'],
    features: ['Rage (2/long rest: +2 damage, resistance to physical damage)', 'Unarmored Defense'] },
  { id: 'rogue', name: 'Rogue', blurb: 'Sneaky, skilled and deadly from the shadows.', hitDie: 8,
    priority: ['dex', 'con', 'int', 'wis', 'cha', 'str'], saves: ['dex', 'int'],
    skills: ['Stealth', 'Sleight of Hand', 'Perception', 'Acrobatics'],
    ac: (m) => 11 + m.dex, acNote: 'Leather armour',
    equipment: ['Leather armour', 'Rapier', 'Shortbow + 20 arrows', "Thieves' tools", "Burglar's pack", '2 Daggers'],
    features: ['Sneak Attack (1d6)', 'Expertise (Stealth, Thieves\' tools)', "Thieves' Cant"] },
  { id: 'ranger', name: 'Ranger', blurb: 'Hunter and tracker of the wild places.', hitDie: 10,
    priority: ['dex', 'wis', 'con', 'str', 'int', 'cha'], saves: ['str', 'dex'], skills: ['Survival', 'Perception', 'Stealth'],
    ac: (m) => 11 + m.dex, acNote: 'Leather armour',
    equipment: ['Leather armour', '2 Shortswords', 'Longbow + 20 arrows', "Explorer's pack"],
    features: ['Favored Enemy (beasts)', 'Natural Explorer (forest)'] },
  { id: 'wizard', name: 'Wizard', blurb: 'Scholar of arcane magic. Fragile but powerful.', hitDie: 6,
    priority: ['int', 'con', 'dex', 'wis', 'cha', 'str'], saves: ['int', 'wis'], skills: ['Arcana', 'History'],
    ac: (m) => 10 + m.dex, acNote: 'No armour (Mage Armor spell: 13 + DEX)',
    equipment: ['Quarterstaff', 'Component pouch', 'Spellbook', "Scholar's pack"],
    features: ['Spellcasting (INT): cantrips Fire Bolt, Mage Hand, Light; prepared from Magic Missile, Shield, Sleep, Burning Hands, Detect Magic, Mage Armor; 2 first-level slots', 'Arcane Recovery'] },
  { id: 'sorcerer', name: 'Sorcerer', blurb: 'Born with raw magic in the blood.', hitDie: 6,
    priority: ['cha', 'con', 'dex', 'wis', 'int', 'str'], saves: ['con', 'cha'], skills: ['Arcana', 'Persuasion'],
    ac: (m) => 13 + m.dex, acNote: 'Draconic Resilience (13 + DEX)',
    equipment: ['Light crossbow + 20 bolts', 'Arcane focus', "Dungeoneer's pack", '2 Daggers'],
    features: ['Spellcasting (CHA): cantrips Fire Bolt, Prestidigitation, Ray of Frost, Light; spells Magic Missile, Chromatic Orb; 2 first-level slots', 'Draconic Bloodline (+1 HP/level)'] },
  { id: 'warlock', name: 'Warlock', blurb: 'Gained magic through a pact with something powerful.', hitDie: 8,
    priority: ['cha', 'con', 'dex', 'wis', 'int', 'str'], saves: ['wis', 'cha'], skills: ['Deception', 'Arcana'],
    ac: (m) => 11 + m.dex, acNote: 'Leather armour',
    equipment: ['Leather armour', 'Light crossbow + 20 bolts', 'Arcane focus', "Scholar's pack", '2 Daggers'],
    features: ['Otherworldly Patron (the Fiend)', 'Pact Magic (CHA): cantrips Eldritch Blast, Minor Illusion; spells Hex, Armor of Agathys; 1 slot per short rest'] },
  { id: 'cleric', name: 'Cleric', blurb: 'Divine healer and warrior of a god.', hitDie: 8,
    priority: ['wis', 'con', 'str', 'dex', 'cha', 'int'], saves: ['wis', 'cha'], skills: ['Medicine', 'Religion'],
    ac: (m) => 16 + dexCap(m, 2), acNote: 'Scale mail + shield',
    equipment: ['Scale mail', 'Shield', 'Mace', 'Holy symbol', "Priest's pack"],
    features: ['Spellcasting (WIS): cantrips Sacred Flame, Guidance, Spare the Dying; prepares Cure Wounds, Bless, Healing Word, Shield of Faith…; 2 first-level slots', 'Divine Domain: Life (bonus healing)'] },
  { id: 'paladin', name: 'Paladin', blurb: 'Holy knight bound by an oath.', hitDie: 10,
    priority: ['str', 'cha', 'con', 'wis', 'dex', 'int'], saves: ['wis', 'cha'], skills: ['Athletics', 'Persuasion'],
    ac: () => 18, acNote: 'Chain mail + shield',
    equipment: ['Chain mail', 'Shield', 'Longsword', '5 Javelins', 'Holy symbol', "Priest's pack"],
    features: ['Divine Sense', 'Lay on Hands (5 HP pool)'] },
  { id: 'monk', name: 'Monk', blurb: 'Martial artist who fights with fists and focus.', hitDie: 8,
    priority: ['dex', 'wis', 'con', 'str', 'int', 'cha'], saves: ['str', 'dex'], skills: ['Acrobatics', 'Insight'],
    ac: (m) => 10 + m.dex + m.wis, acNote: 'Unarmored Defense (10 + DEX + WIS)',
    equipment: ['Shortsword', '10 Darts', "Explorer's pack"],
    features: ['Unarmored Defense', 'Martial Arts (1d4 unarmed, bonus-action strike)'] },
  { id: 'druid', name: 'Druid', blurb: 'Keeper of nature, wielding its magic.', hitDie: 8,
    priority: ['wis', 'con', 'dex', 'int', 'cha', 'str'], saves: ['int', 'wis'], skills: ['Nature', 'Animal Handling'],
    ac: (m) => 13 + m.dex, acNote: 'Leather armour + wooden shield',
    equipment: ['Leather armour', 'Wooden shield', 'Scimitar', 'Druidic focus', "Explorer's pack"],
    features: ['Druidic', 'Spellcasting (WIS): cantrips Druidcraft, Produce Flame; prepares Cure Wounds, Entangle, Faerie Fire, Goodberry…; 2 first-level slots'] },
  { id: 'bard', name: 'Bard', blurb: 'Performer whose words and music carry magic.', hitDie: 8,
    priority: ['cha', 'dex', 'con', 'wis', 'int', 'str'], saves: ['dex', 'cha'], skills: ['Performance', 'Persuasion', 'Insight'],
    ac: (m) => 11 + m.dex, acNote: 'Leather armour',
    equipment: ['Leather armour', 'Rapier', 'Lute', "Entertainer's pack", 'Dagger'],
    features: ['Bardic Inspiration (d6, CHA mod uses per long rest)', 'Spellcasting (CHA): cantrips Vicious Mockery, Minor Illusion; spells Healing Word, Charm Person, Dissonant Whispers, Thunderwave; 2 first-level slots'] },
];

export interface Preset {
  id: string;
  name: string;
  blurb: string;
  /** Builds the six scores for a class, before racial bonuses. */
  scores: (cls: CharClass) => Abilities;
}

const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];

function assign(order: Ability[], values: number[]): Abilities {
  const out = {} as Abilities;
  order.forEach((a, i) => { out[a] = values[i]; });
  return out;
}

function promote(order: Ability[], ability: Ability, toIndex: number): Ability[] {
  const rest = order.filter((a) => a !== ability);
  rest.splice(toIndex, 0, ability);
  return rest;
}

export const PRESETS: Preset[] = [
  { id: 'specialist', name: 'Specialist', blurb: 'Great at what your class does best, weak elsewhere.',
    scores: (c) => assign(c.priority, STANDARD_ARRAY) },
  { id: 'sturdy', name: 'Sturdy', blurb: 'Your main stat plus lots of toughness. Hard to knock down.',
    scores: (c) => assign(promote(c.priority, 'con', 1), STANDARD_ARRAY) },
  { id: 'charming', name: 'Silver-tongued', blurb: 'Your main stat plus a winning personality.',
    scores: (c) => assign(promote(c.priority, c.priority[0] === 'cha' ? 'wis' : 'cha', 1), STANDARD_ARRAY) },
  { id: 'balanced', name: 'Well-rounded', blurb: 'No real weaknesses, no huge strengths.',
    scores: (c) => assign(c.priority, [13, 13, 13, 12, 12, 12]) },
];

export type LifeStatus = 'up' | 'dying' | 'stable' | 'out' | 'dead';

export const mod = (score: number) => Math.floor((score - 10) / 2);

export interface Character {
  id: string;
  name: string;
  player: string;
  raceId: string;
  race: string;
  classId: string;
  className: string;
  level: number;
  abilities: Abilities;
  maxHp: number;
  hp: number;
  tempHp: number;
  ac: number;
  acNote: string;
  speed: number;
  proficiencyBonus: number;
  saves: Ability[];
  skills: string[];
  inventory: { name: string; qty: number }[];
  gold: number;
  xp: number;
  conditions: string[];
  features: string[];
  notes: string;
  resources: Resource[];
  status: LifeStatus;
  deathSaves: { successes: number; failures: number };
}

export interface CharacterChoices {
  name: string;
  player: string;
  race: string;
  className: string;
  preset: string;
}

export function buildCharacter(id: string, choice: CharacterChoices): Character {
  const race = RACES.find((r) => r.id === choice.race);
  const cls = CLASSES.find((c) => c.id === choice.className);
  const preset = PRESETS.find((p) => p.id === choice.preset);
  if (!race) throw new Error(`Unknown race "${choice.race}"`);
  if (!cls) throw new Error(`Unknown class "${choice.className}"`);
  if (!preset) throw new Error(`Unknown preset "${choice.preset}"`);
  if (!choice.name.trim()) throw new Error('Character needs a name');

  const abilities = preset.scores(cls);
  for (const [a, bonus] of Object.entries(race.bonuses) as [Ability, number][]) abilities[a] += bonus;
  if (race.id === 'half-elf') {
    // +1 to the class's two most important abilities that aren't CHA.
    cls.priority.filter((a) => a !== 'cha').slice(0, 2).forEach((a) => { abilities[a] += 1; });
  }

  const m = Object.fromEntries(ABILITIES.map((a) => [a, mod(abilities[a])])) as Abilities;
  let maxHp = cls.hitDie + m.con;
  if (race.id === 'dwarf' || cls.id === 'sorcerer') maxHp += 1;
  maxHp = Math.max(1, maxHp);

  const skills = [...cls.skills];
  if (race.id === 'elf' && !skills.includes('Perception')) skills.push('Perception');
  if (race.id === 'half-orc' && !skills.includes('Intimidation')) skills.push('Intimidation');
  if (race.id === 'half-elf') for (const s of ['Insight', 'Persuasion', 'Deception']) if (!skills.includes(s) && skills.length < cls.skills.length + 2) skills.push(s);

  return {
    id,
    name: choice.name.trim(),
    player: choice.player.trim(),
    raceId: race.id,
    race: race.name,
    classId: cls.id,
    className: cls.name,
    level: 1,
    abilities,
    maxHp,
    hp: maxHp,
    tempHp: 0,
    ac: cls.ac(m),
    acNote: cls.acNote,
    speed: race.speed,
    proficiencyBonus: 2,
    saves: cls.saves,
    skills,
    inventory: cls.equipment.map((name) => ({ name, qty: 1 })),
    gold: 10,
    xp: 0,
    conditions: [],
    features: [...race.traits, ...cls.features],
    notes: '',
    resources: defaultResources(cls.id, abilities),
    status: 'up',
    deathSaves: { successes: 0, failures: 0 },
  };
}

const FI_ABILITY: Record<Ability, string> = { str: 'Voima', dex: 'Ketteryys', con: 'Kestävyys', int: 'Älykkyys', wis: 'Viisaus', cha: 'Karisma' };
const EN_ABILITY: Record<Ability, string> = { str: 'Strength', dex: 'Dexterity', con: 'Constitution', int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma' };
export const FI_SKILLS: Record<string, string> = {
  Acrobatics: 'Akrobatia', 'Animal Handling': 'Eläinten käsittely', Arcana: 'Mystiikka', Athletics: 'Atletiikka',
  Deception: 'Harhautus', History: 'Historia', Insight: 'Ihmistuntemus', Intimidation: 'Pelottelu',
  Investigation: 'Tutkiminen', Medicine: 'Lääkintä', Nature: 'Luonto', Perception: 'Havainnointi',
  Performance: 'Esiintyminen', Persuasion: 'Suostuttelu', Religion: 'Uskonto', 'Sleight of Hand': 'Näppäryys',
  Stealth: 'Hiiviskely', Survival: 'Selviytyminen',
};

/** Modifier for a check, so the DM doesn't have to do the arithmetic. */
export function checkModifier(c: Character, what: string, lang: 'en' | 'fi' = 'en'): { modifier: number; label: string } {
  const key = what.trim().toLowerCase();
  const fi = lang === 'fi';
  const ab = (a: Ability) => (fi ? FI_ABILITY[a] : EN_ABILITY[a]);
  const skill = Object.keys(SKILLS).find((s) => s.toLowerCase() === key || FI_SKILLS[s].toLowerCase() === key);
  if (skill) {
    const ability = SKILLS[skill];
    const prof = c.skills.includes(skill) ? c.proficiencyBonus : 0;
    const label = fi ? `${FI_SKILLS[skill]} (${ab(ability)}) -heitto` : `${ab(ability)} (${skill}) check`;
    return { modifier: mod(c.abilities[ability]) + prof, label };
  }
  const save = /^(str|dex|con|int|wis|cha)\s*save$/.exec(key);
  if (save) {
    const a = save[1] as Ability;
    return { modifier: mod(c.abilities[a]) + (c.saves.includes(a) ? c.proficiencyBonus : 0), label: fi ? `${ab(a)} -pelastusheitto` : `${ab(a)} saving throw` };
  }
  if ((ABILITIES as readonly string[]).includes(key)) {
    const a = key as Ability;
    return { modifier: mod(c.abilities[a]), label: fi ? `${ab(a)} -heitto` : `${ab(a)} check` };
  }
  throw new Error(`Unknown check "${what}". Use a skill name (e.g. "Stealth"), an ability ("dex") or a save ("dex save").`);
}
