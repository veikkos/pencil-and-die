// A small slice of D&D 5e (SRD) — enough to build a level-1 character from three
// simple choices. The DM (Claude) handles everything beyond that.

import { defaultResources, type Resource } from './resources.ts';
import { spellsById, type Spell } from './spells.ts';

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

export interface Feature {
  name: string;
  /** What it does, in a sentence or two. */
  text: string;
  source: 'race' | 'class' | 'other';
  /** The limited-use resource it spends, if any. */
  resourceId?: string;
  /** The hero level it came with; absent for level 1. */
  level?: number;
}

export interface Item {
  name: string;
  qty: number;
  /** What it is or does, for things the DM invents: "glows blue; crush once to heal 2d4+2". */
  note?: string;
}

/**
 * "Murun kristalli (hehkuu sinistä; kerran: murskaa ja paranna 2d4+2)": before items had notes the
 * DM put the description in the name. A long enough bracket at the end becomes the note.
 */
export function splitItemName(name: string): { name: string; note?: string } {
  const m = /^(.+?)\s*\(([^()]+)\)$/.exec(name.trim());
  if (!m || m[2].trim().split(/\s+/).length < 4) return { name: name.trim() };
  return { name: m[1], note: m[2].trim() };
}

export interface Effect {
  name: string;
  note: string;
}

export interface Race {
  id: string;
  name: string;
  blurb: string;
  bonuses: Partial<Abilities>;
  speed: number;
  traits: Feature[];
  spells?: string[];
}

const trait = (name: string, text: string): Feature => ({ name, text, source: 'race' });
const feature = (name: string, text: string, resourceId?: string): Feature => ({ name, text, source: 'class', ...(resourceId ? { resourceId } : {}) });

const DARKVISION = trait('Darkvision', 'See in dim light within 60 ft as if it were bright, and in darkness as if it were dim (no colours).');
const FEY_ANCESTRY = trait('Fey Ancestry', 'Advantage on saves against being charmed; magic cannot put you to sleep.');

export const RACES: Race[] = [
  { id: 'human', name: 'Human', blurb: 'Adaptable and ambitious; a little good at everything.',
    bonuses: { str: 1, dex: 1, con: 1, int: 1, wis: 1, cha: 1 }, speed: 30,
    traits: [trait('Extra language', 'You speak one more language of your choice.')] },
  { id: 'elf', name: 'Elf (High)', blurb: 'Graceful, keen-eyed and long-lived, with a touch of magic.',
    bonuses: { dex: 2, int: 1 }, speed: 30,
    traits: [DARKVISION, trait('Keen Senses', 'Proficient in Perception.'), FEY_ANCESTRY,
      trait('Trance', 'Four hours of meditation give you the rest of eight hours of sleep.'),
      trait('Wizard cantrip', 'You know one wizard cantrip, cast with INT.')] },
  { id: 'dwarf', name: 'Dwarf (Hill)', blurb: 'Stout, stubborn and hard to kill.',
    bonuses: { con: 2, wis: 1 }, speed: 25,
    traits: [DARKVISION, trait('Dwarven Resilience', 'Advantage on saves against poison, and resistance to poison damage.'),
      trait('Stonecunning', 'Double proficiency on History checks about stonework.'),
      trait('Dwarven Toughness', '+1 hit point per level.')] },
  { id: 'halfling', name: 'Halfling (Lightfoot)', blurb: 'Small, cheerful and uncannily lucky.',
    bonuses: { dex: 2, cha: 1 }, speed: 25,
    traits: [trait('Lucky', 'When you roll a 1 on an attack, check or save, reroll it and use the new roll.'),
      trait('Brave', 'Advantage on saves against being frightened.'),
      trait('Halfling Nimbleness', 'You can move through the space of any creature larger than you.'),
      trait('Naturally Stealthy', 'You can try to hide behind a creature at least one size larger than you.')] },
  { id: 'gnome', name: 'Gnome (Rock)', blurb: 'Curious tinkerers with quick minds.',
    bonuses: { int: 2, con: 1 }, speed: 25,
    traits: [DARKVISION, trait('Gnome Cunning', 'Advantage on INT, WIS and CHA saves against magic.'),
      trait("Artificer's Lore", 'Double proficiency on History checks about magic items, alchemy and technology.'),
      trait('Tinker', 'You can build tiny clockwork toys, fire starters and music boxes.')] },
  { id: 'half-elf', name: 'Half-Elf', blurb: 'At home in two worlds and charming in both.',
    bonuses: { cha: 2 }, speed: 30,
    traits: [DARKVISION, FEY_ANCESTRY, trait('Versatile', '+1 to two other abilities and two extra skills.')] },
  { id: 'half-orc', name: 'Half-Orc', blurb: 'Fierce and enduring; hard to put down.',
    bonuses: { str: 2, con: 1 }, speed: 30,
    traits: [DARKVISION, trait('Menacing', 'Proficient in Intimidation.'),
      trait('Relentless Endurance', 'Once per long rest, when you drop to 0 HP but are not killed, you drop to 1 HP instead.'),
      trait('Savage Attacks', 'On a melee critical hit, roll one of the weapon damage dice once more and add it.')] },
  { id: 'dragonborn', name: 'Dragonborn', blurb: 'Proud draconic folk who breathe elemental fire.',
    bonuses: { str: 2, cha: 1 }, speed: 30,
    traits: [trait('Draconic Ancestry', 'Red dragon: your breath and resistance are fire.'),
      trait('Breath Weapon', 'Action, once per short rest: a 15-ft cone of fire, 2d6 damage, DEX save (DC 8 + CON + proficiency) for half.'),
      trait('Damage Resistance', 'You take half damage from fire.')] },
  { id: 'tiefling', name: 'Tiefling', blurb: 'Touched by the infernal; clever, magnetic, distrusted.',
    bonuses: { cha: 2, int: 1 }, speed: 30,
    traits: [DARKVISION, trait('Hellish Resistance', 'You take half damage from fire.'),
      trait('Infernal Legacy', 'You know the Thaumaturgy cantrip.')],
    spells: ['thaumaturgy'] },
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
  /** Skills with double proficiency. */
  expertise?: string[];
  /** Armour class from equipment, given ability modifiers. */
  ac: (mod: Abilities) => number;
  acNote: string;
  equipment: { name: string; qty: number }[];
  features: Feature[];
  /** Full casters get slots from level 1, half casters from level 2; warlocks have pact slots. */
  spellcasting?: { ability: Ability; kind: 'full' | 'half' | 'pact' };
  spells?: string[];
}

const dexCap = (mod: Abilities, cap: number) => Math.min(mod.dex, cap);
const kit = (...items: (string | [string, number])[]) => items.map((i) => (typeof i === 'string' ? { name: i, qty: 1 } : { name: i[0], qty: i[1] }));

export const CLASSES: CharClass[] = [
  { id: 'fighter', name: 'Fighter', blurb: 'Master of weapons and armour. Simple, sturdy, reliable.', hitDie: 10,
    priority: ['str', 'con', 'dex', 'wis', 'cha', 'int'], saves: ['str', 'con'], skills: ['Athletics', 'Perception'],
    // Chain mail 16 + shield 2 + Defense 1.
    ac: () => 19, acNote: 'Chain mail + shield',
    equipment: kit('Chain mail', 'Shield', 'Longsword', ['Handaxe', 2], "Explorer's pack"),
    features: [feature('Fighting Style: Defense', '+1 AC while wearing armour (already counted).'),
      feature('Second Wind', 'Bonus action: regain 1d10 + your level in hit points.', 'second-wind')] },
  { id: 'barbarian', name: 'Barbarian', blurb: 'Furious warrior who shrugs off blows.', hitDie: 12,
    priority: ['str', 'con', 'dex', 'wis', 'cha', 'int'], saves: ['str', 'con'], skills: ['Athletics', 'Survival'],
    ac: (m) => 10 + m.dex + m.con, acNote: 'Unarmored Defense (10 + DEX + CON)',
    equipment: kit('Greataxe', ['Handaxe', 2], "Explorer's pack", ['Javelin', 4]),
    features: [feature('Rage', 'Bonus action, lasts a minute: +2 damage on STR melee attacks, advantage on STR checks and saves, half damage from bludgeoning, piercing and slashing.', 'rage'),
      feature('Unarmored Defense', 'Without armour your AC is 10 + DEX + CON.')] },
  { id: 'rogue', name: 'Rogue', blurb: 'Sneaky, skilled and deadly from the shadows.', hitDie: 8,
    priority: ['dex', 'con', 'int', 'wis', 'cha', 'str'], saves: ['dex', 'int'],
    skills: ['Stealth', 'Sleight of Hand', 'Perception', 'Acrobatics'], expertise: ['Stealth'],
    ac: (m) => 11 + m.dex, acNote: 'Leather armour',
    equipment: kit('Leather armour', 'Rapier', 'Shortbow', ['Arrows', 20], "Thieves' tools", "Burglar's pack", ['Dagger', 2]),
    features: [feature('Sneak Attack', 'Once per turn, extra damage (the dice shown) with a finesse or ranged weapon when you have advantage or an ally is next to the target.'),
      feature('Expertise', "Double proficiency in Stealth and with thieves' tools."),
      feature("Thieves' Cant", 'A secret mix of slang and signs only rogues understand.')] },
  { id: 'ranger', name: 'Ranger', blurb: 'Hunter and tracker of the wild places.', hitDie: 10,
    priority: ['dex', 'wis', 'con', 'str', 'int', 'cha'], saves: ['str', 'dex'], skills: ['Survival', 'Perception', 'Stealth'],
    ac: (m) => 11 + m.dex, acNote: 'Leather armour',
    equipment: kit('Leather armour', ['Shortsword', 2], 'Longbow', ['Arrows', 20], "Explorer's pack"),
    features: [feature('Favored Enemy', 'Beasts: advantage on Survival to track them and on INT checks to recall facts about them.'),
      feature('Natural Explorer', 'Forest: your group cannot get lost there, and you track and forage twice as well.')],
    spellcasting: { ability: 'wis', kind: 'half' } },
  { id: 'wizard', name: 'Wizard', blurb: 'Scholar of arcane magic. Fragile but powerful.', hitDie: 6,
    priority: ['int', 'con', 'dex', 'wis', 'cha', 'str'], saves: ['int', 'wis'], skills: ['Arcana', 'History'],
    ac: (m) => 10 + m.dex, acNote: 'No armour (Mage Armor spell: 13 + DEX)',
    equipment: kit('Quarterstaff', 'Component pouch', 'Spellbook', "Scholar's pack"),
    features: [feature('Arcane Recovery', 'Once a day after a short rest, regain a spent spell slot.', 'arcane-recovery')],
    spellcasting: { ability: 'int', kind: 'full' },
    spells: ['fire-bolt', 'mage-hand', 'light', 'magic-missile', 'shield', 'sleep', 'burning-hands', 'detect-magic', 'mage-armor'] },
  { id: 'sorcerer', name: 'Sorcerer', blurb: 'Born with raw magic in the blood.', hitDie: 6,
    priority: ['cha', 'con', 'dex', 'wis', 'int', 'str'], saves: ['con', 'cha'], skills: ['Arcana', 'Persuasion'],
    ac: (m) => 13 + m.dex, acNote: 'Draconic Resilience (13 + DEX)',
    equipment: kit('Light crossbow', ['Bolts', 20], 'Arcane focus', "Dungeoneer's pack", ['Dagger', 2]),
    features: [feature('Draconic Bloodline', 'Dragon scales: AC 13 + DEX without armour, and +1 hit point per level.')],
    spellcasting: { ability: 'cha', kind: 'full' },
    spells: ['fire-bolt', 'prestidigitation', 'ray-of-frost', 'light', 'magic-missile', 'chromatic-orb'] },
  { id: 'warlock', name: 'Warlock', blurb: 'Gained magic through a pact with something powerful.', hitDie: 8,
    priority: ['cha', 'con', 'dex', 'wis', 'int', 'str'], saves: ['wis', 'cha'], skills: ['Deception', 'Arcana'],
    ac: (m) => 11 + m.dex, acNote: 'Leather armour',
    equipment: kit('Leather armour', 'Light crossbow', ['Bolts', 20], 'Arcane focus', "Scholar's pack", ['Dagger', 2]),
    features: [feature('Otherworldly Patron: the Fiend', 'When you drop a hostile creature to 0 HP, gain temporary HP equal to CHA modifier + level.'),
      feature('Pact Magic', 'Your spell slot comes back after a short rest.')],
    spellcasting: { ability: 'cha', kind: 'pact' },
    spells: ['eldritch-blast', 'minor-illusion', 'hex', 'armor-of-agathys'] },
  { id: 'cleric', name: 'Cleric', blurb: 'Divine healer and warrior of a god.', hitDie: 8,
    priority: ['wis', 'con', 'str', 'dex', 'cha', 'int'], saves: ['wis', 'cha'], skills: ['Medicine', 'Religion'],
    ac: (m) => 16 + dexCap(m, 2), acNote: 'Scale mail + shield',
    equipment: kit('Scale mail', 'Shield', 'Mace', 'Holy symbol', "Priest's pack"),
    features: [feature('Divine Domain: Life', 'Your healing spells restore an extra 2 + spell level hit points.')],
    spellcasting: { ability: 'wis', kind: 'full' },
    spells: ['sacred-flame', 'guidance', 'spare-the-dying', 'cure-wounds', 'bless', 'healing-word', 'shield-of-faith'] },
  { id: 'paladin', name: 'Paladin', blurb: 'Holy knight bound by an oath.', hitDie: 10,
    priority: ['str', 'cha', 'con', 'wis', 'dex', 'int'], saves: ['wis', 'cha'], skills: ['Athletics', 'Persuasion'],
    ac: () => 18, acNote: 'Chain mail + shield',
    equipment: kit('Chain mail', 'Shield', 'Longsword', ['Javelin', 5], 'Holy symbol', "Priest's pack"),
    features: [feature('Divine Sense', 'Action: until your next turn you know where celestials, fiends and undead are within 60 ft.'),
      feature('Lay on Hands', 'Action: touch a creature and restore hit points from your pool, or spend 5 to cure a disease or poison.', 'lay-on-hands')],
    spellcasting: { ability: 'cha', kind: 'half' } },
  { id: 'monk', name: 'Monk', blurb: 'Martial artist who fights with fists and focus.', hitDie: 8,
    priority: ['dex', 'wis', 'con', 'str', 'int', 'cha'], saves: ['str', 'dex'], skills: ['Acrobatics', 'Insight'],
    ac: (m) => 10 + m.dex + m.wis, acNote: 'Unarmored Defense (10 + DEX + WIS)',
    equipment: kit('Shortsword', ['Dart', 10], "Explorer's pack"),
    features: [feature('Unarmored Defense', 'Without armour your AC is 10 + DEX + WIS.'),
      feature('Martial Arts', 'Unarmed strikes use DEX and the martial arts die; after attacking you can make one unarmed strike as a bonus action.')] },
  { id: 'druid', name: 'Druid', blurb: 'Keeper of nature, wielding its magic.', hitDie: 8,
    priority: ['wis', 'con', 'dex', 'int', 'cha', 'str'], saves: ['int', 'wis'], skills: ['Nature', 'Animal Handling'],
    ac: (m) => 13 + m.dex, acNote: 'Leather armour + wooden shield',
    equipment: kit('Leather armour', 'Wooden shield', 'Scimitar', 'Druidic focus', "Explorer's pack"),
    features: [feature('Druidic', 'The secret language of druids; you can leave hidden messages in it.')],
    spellcasting: { ability: 'wis', kind: 'full' },
    spells: ['druidcraft', 'produce-flame', 'cure-wounds', 'entangle', 'faerie-fire', 'goodberry'] },
  { id: 'bard', name: 'Bard', blurb: 'Performer whose words and music carry magic.', hitDie: 8,
    priority: ['cha', 'dex', 'con', 'wis', 'int', 'str'], saves: ['dex', 'cha'], skills: ['Performance', 'Persuasion', 'Insight'],
    ac: (m) => 11 + m.dex, acNote: 'Leather armour',
    equipment: kit('Leather armour', 'Rapier', 'Lute', "Entertainer's pack", 'Dagger'),
    features: [feature('Bardic Inspiration', 'Bonus action: a creature within 60 ft gets your inspiration die to add to one attack, check or save in the next 10 minutes.', 'bardic-inspiration')],
    spellcasting: { ability: 'cha', kind: 'full' },
    spells: ['vicious-mockery', 'minor-illusion', 'healing-word', 'charm-person', 'dissonant-whispers', 'thunderwave'] },
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
  /** Skills with double proficiency (the rogue's Expertise). */
  expertise: string[];
  inventory: Item[];
  gold: number;
  xp: number;
  conditions: string[];
  /** Spell and feature effects on the hero (Blessed, Raging), with what they do. */
  effects: Effect[];
  features: Feature[];
  spells: Spell[];
  notes: string;
  resources: Resource[];
  status: LifeStatus;
  deathSaves: { successes: number; failures: number };
  /** The DM has offered the next level; the player is choosing. */
  pendingLevel?: number;
}

/** A feature the DM wrote as plain text: "Acorn amulet: once a day, reroll a failed save" splits in two. */
export function featureFromText(text: string): Feature {
  const [, name, rest] = /^([^:]{1,60}):\s+(.+)$/s.exec(text.trim()) ?? [null, text.trim(), ''];
  return { name, text: rest, source: 'other' };
}

/**
 * Features of characters made before features were data were strings like
 * "Second Wind (bonus action: heal 1d10 + level, once per rest)". Each becomes the matching
 * structured feature; the old spellcasting lines are now the spell list.
 */
export function upgradeFeatures(raceId: string, classId: string, features: (Feature | string)[]): Feature[] {
  const defaults = [...(RACES.find((r) => r.id === raceId)?.traits ?? []), ...(CLASSES.find((c) => c.id === classId)?.features ?? [])];
  const out: Feature[] = [];
  for (const f of features) {
    if (typeof f !== 'string') { out.push(f); continue; }
    if (/^spellcasting\b/i.test(f)) continue;
    const text = /other abilities|extra skills/i.test(f) ? 'versatile' : f.toLowerCase();
    const match = defaults.find((d) => text.includes(d.name.split(':')[0].toLowerCase()));
    const next = match ? { ...match } : featureFromText(f);
    if (!out.some((x) => x.name === next.name)) out.push(next);
  }
  return out;
}

export function defaultSpells(raceId: string, classId: string): Spell[] {
  return spellsById([...(CLASSES.find((c) => c.id === classId)?.spells ?? []), ...(RACES.find((r) => r.id === raceId)?.spells ?? [])]);
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
    expertise: [...(cls.expertise ?? [])],
    inventory: cls.equipment.map((i) => ({ ...i })),
    gold: 10,
    xp: 0,
    conditions: [],
    effects: [],
    features: [...race.traits, ...cls.features].map((f) => ({ ...f })),
    spells: defaultSpells(race.id, cls.id),
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

/** One term of a number on the sheet, so the page can show how it adds up. */
export type Part =
  | { from: 'ability'; ability: Ability; value: number }
  | { from: 'proficiency' | 'expertise' | 'half' | 'base' | 'bonus'; value: number };

export const total = (parts: Part[]) => parts.reduce((n, p) => n + p.value, 0);
export const abilityPart = (c: Character, ability: Ability): Part => ({ from: 'ability', ability, value: mod(c.abilities[ability]) });

/** The bard's Jack of All Trades: half proficiency on ability checks without proficiency. */
export const jackPart = (c: Character): Part[] =>
  (c.features.some((f) => f.name === 'Jack of All Trades') ? [{ from: 'half', value: Math.floor(c.proficiencyBonus / 2) }] : []);

/** Modifier for a check, so the DM doesn't have to do the arithmetic. */
export function checkModifier(c: Character, what: string, lang: 'en' | 'fi' = 'en'): { modifier: number; label: string; parts: Part[] } {
  const key = what.trim().toLowerCase();
  const fi = lang === 'fi';
  const ab = (a: Ability) => (fi ? FI_ABILITY[a] : EN_ABILITY[a]);
  const out = (label: string, parts: Part[]) => ({ modifier: total(parts), label, parts });
  const skill = Object.keys(SKILLS).find((s) => s.toLowerCase() === key || FI_SKILLS[s].toLowerCase() === key);
  if (skill) {
    const ability = SKILLS[skill];
    const parts = [abilityPart(c, ability)];
    if (c.skills.includes(skill)) parts.push({ from: 'proficiency', value: c.proficiencyBonus });
    if (c.skills.includes(skill) && c.expertise?.includes(skill)) parts.push({ from: 'expertise', value: c.proficiencyBonus });
    if (!c.skills.includes(skill)) parts.push(...jackPart(c));
    return out(fi ? `${FI_SKILLS[skill]} (${ab(ability)}) -heitto` : `${ab(ability)} (${skill}) check`, parts);
  }
  const save = /^(str|dex|con|int|wis|cha)\s*save$/.exec(key);
  if (save) {
    const a = save[1] as Ability;
    const parts = [abilityPart(c, a), ...(c.saves.includes(a) ? [{ from: 'proficiency' as const, value: c.proficiencyBonus }] : [])];
    return out(fi ? `${ab(a)} -pelastusheitto` : `${ab(a)} saving throw`, parts);
  }
  if ((ABILITIES as readonly string[]).includes(key)) {
    const a = key as Ability;
    return out(fi ? `${ab(a)} -heitto` : `${ab(a)} check`, [abilityPart(c, a), ...jackPart(c)]);
  }
  throw new Error(`Unknown check "${what}". Use a skill name (e.g. "Stealth"), an ability ("dex") or a save ("dex save").`);
}
