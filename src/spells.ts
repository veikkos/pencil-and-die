// The SRD cantrips and first-level spells the classes and races start with. What a spell does
// is in its summary for the DM to apply; the engine only knows its numbers.

import type { Ability } from './rules.ts';

export interface Spell {
  id: string;
  name: string;
  level: 0 | 1;
  castingTime: 'action' | 'bonus' | 'reaction';
  range: string;
  concentration?: boolean;
  summary: string;
  attack?: 'ranged' | 'melee';
  /** Targets roll this save against the caster's spell save DC. */
  save?: Ability;
  dice?: string;
  /** Flat bonus added to the dice. */
  bonus?: number;
  /** Add the spellcasting ability modifier to the dice. */
  addMod?: boolean;
  /** How many times the dice are rolled, each separately (Magic Missile's darts). */
  times?: number;
  damageType?: string;
  heal?: boolean;
}

export const SPELLS: Spell[] = [
  // Cantrips
  { id: 'fire-bolt', name: 'Fire Bolt', level: 0, castingTime: 'action', range: '120 ft', attack: 'ranged', dice: '1d10', damageType: 'fire',
    summary: 'Hurl a mote of fire. Unattended flammable objects catch fire.' },
  { id: 'ray-of-frost', name: 'Ray of Frost', level: 0, castingTime: 'action', range: '60 ft', attack: 'ranged', dice: '1d8', damageType: 'cold',
    summary: 'A freezing beam; on a hit the target is 10 ft slower until your next turn.' },
  { id: 'eldritch-blast', name: 'Eldritch Blast', level: 0, castingTime: 'action', range: '120 ft', attack: 'ranged', dice: '1d10', damageType: 'force',
    summary: 'A crackling beam of force.' },
  { id: 'sacred-flame', name: 'Sacred Flame', level: 0, castingTime: 'action', range: '60 ft', save: 'dex', dice: '1d8', damageType: 'radiant',
    summary: 'Radiant flame falls on a creature you can see; cover does not help it.' },
  { id: 'produce-flame', name: 'Produce Flame', level: 0, castingTime: 'action', range: '30 ft', attack: 'ranged', dice: '1d8', damageType: 'fire',
    summary: 'A flame in your hand lights 10 ft around you, or you throw it.' },
  { id: 'vicious-mockery', name: 'Vicious Mockery', level: 0, castingTime: 'action', range: '60 ft', save: 'wis', dice: '1d4', damageType: 'psychic',
    summary: 'Insults laced with magic; on a failed save the target also has disadvantage on its next attack.' },
  { id: 'mage-hand', name: 'Mage Hand', level: 0, castingTime: 'action', range: '30 ft',
    summary: 'A floating spectral hand that can carry up to 10 lb, open doors and fetch things for a minute.' },
  { id: 'light', name: 'Light', level: 0, castingTime: 'action', range: 'Touch',
    summary: 'An object shines like a torch (20 ft bright light) for an hour.' },
  { id: 'prestidigitation', name: 'Prestidigitation', level: 0, castingTime: 'action', range: '10 ft',
    summary: 'Small magic tricks: sparks, a puff of wind, clean or soil an object, warm or chill food, a tiny mark.' },
  { id: 'minor-illusion', name: 'Minor Illusion', level: 0, castingTime: 'action', range: '30 ft',
    summary: 'A sound or a still image no bigger than a 5-ft cube, for a minute.' },
  { id: 'guidance', name: 'Guidance', level: 0, castingTime: 'action', range: 'Touch', concentration: true,
    summary: 'A willing creature adds 1d4 to one ability check within the next minute.' },
  { id: 'spare-the-dying', name: 'Spare the Dying', level: 0, castingTime: 'action', range: 'Touch',
    summary: 'A creature at 0 HP becomes stable.' },
  { id: 'druidcraft', name: 'Druidcraft', level: 0, castingTime: 'action', range: '30 ft',
    summary: 'Small nature magic: predict the weather, make a flower bloom, a harmless sensory effect, light or snuff a candle.' },
  { id: 'thaumaturgy', name: 'Thaumaturgy', level: 0, castingTime: 'action', range: '30 ft',
    summary: 'A minor wonder: a booming voice, flickering flames, tremors, doors flung open, eyes that change.' },
  // First level
  { id: 'magic-missile', name: 'Magic Missile', level: 1, castingTime: 'action', range: '120 ft', dice: '1d4', bonus: 1, times: 3, damageType: 'force',
    summary: 'Three glowing darts that always hit; aim them at one creature or several.' },
  { id: 'shield', name: 'Shield', level: 1, castingTime: 'reaction', range: 'Self',
    summary: 'When you are hit: +5 AC until your next turn, including against that attack.' },
  { id: 'sleep', name: 'Sleep', level: 1, castingTime: 'action', range: '90 ft', dice: '5d8',
    summary: 'Roll 5d8: creatures with that many hit points in total fall asleep, weakest first.' },
  { id: 'burning-hands', name: 'Burning Hands', level: 1, castingTime: 'action', range: 'Self (15-ft cone)', save: 'dex', dice: '3d6', damageType: 'fire',
    summary: 'A sheet of flame from your fingertips; half damage on a successful save.' },
  { id: 'detect-magic', name: 'Detect Magic', level: 1, castingTime: 'action', range: 'Self', concentration: true,
    summary: 'For 10 minutes you sense magic within 30 ft and can see its aura.' },
  { id: 'mage-armor', name: 'Mage Armor', level: 1, castingTime: 'action', range: 'Touch',
    summary: 'A creature without armour has AC 13 + DEX for 8 hours.' },
  { id: 'chromatic-orb', name: 'Chromatic Orb', level: 1, castingTime: 'action', range: '90 ft', attack: 'ranged', dice: '3d8', damageType: 'acid, cold, fire, lightning, poison or thunder',
    summary: 'An orb of the element you choose.' },
  { id: 'hex', name: 'Hex', level: 1, castingTime: 'bonus', range: '90 ft', concentration: true,
    summary: 'Curse a creature for an hour: your hits on it deal an extra 1d6 necrotic, and it has disadvantage on checks of one ability you pick.' },
  { id: 'armor-of-agathys', name: 'Armor of Agathys', level: 1, castingTime: 'action', range: 'Self',
    summary: 'Gain 5 temporary HP; whoever hits you in melee while they last takes 5 cold damage.' },
  { id: 'cure-wounds', name: 'Cure Wounds', level: 1, castingTime: 'action', range: 'Touch', dice: '1d8', addMod: true, heal: true,
    summary: 'A creature you touch regains hit points.' },
  { id: 'healing-word', name: 'Healing Word', level: 1, castingTime: 'bonus', range: '60 ft', dice: '1d4', addMod: true, heal: true,
    summary: 'A creature you can see regains hit points.' },
  { id: 'bless', name: 'Bless', level: 1, castingTime: 'action', range: '30 ft', concentration: true,
    summary: 'Up to three creatures add 1d4 to their attack rolls and saving throws for a minute.' },
  { id: 'shield-of-faith', name: 'Shield of Faith', level: 1, castingTime: 'bonus', range: '60 ft', concentration: true,
    summary: 'A shimmering field gives a creature +2 AC for 10 minutes.' },
  { id: 'entangle', name: 'Entangle', level: 1, castingTime: 'action', range: '90 ft', concentration: true, save: 'str',
    summary: 'Grasping weeds fill a 20-ft square for a minute; creatures there that fail the save are restrained.' },
  { id: 'faerie-fire', name: 'Faerie Fire', level: 1, castingTime: 'action', range: '60 ft', concentration: true, save: 'dex',
    summary: 'Creatures in a 20-ft cube that fail the save glow for a minute: attacks against them have advantage and they cannot hide.' },
  { id: 'goodberry', name: 'Goodberry', level: 1, castingTime: 'action', range: 'Touch',
    summary: 'Ten magic berries that each heal 1 HP and feed a person for a day.' },
  { id: 'charm-person', name: 'Charm Person', level: 1, castingTime: 'action', range: '30 ft', save: 'wis',
    summary: 'A humanoid that fails the save treats you as a friendly acquaintance for an hour.' },
  { id: 'dissonant-whispers', name: 'Dissonant Whispers', level: 1, castingTime: 'action', range: '60 ft', save: 'wis', dice: '3d6', damageType: 'psychic',
    summary: 'A creature that fails the save takes the damage and must flee from you; half damage and no fleeing on a success.' },
  { id: 'thunderwave', name: 'Thunderwave', level: 1, castingTime: 'action', range: 'Self (15-ft cube)', save: 'con', dice: '2d8', damageType: 'thunder',
    summary: 'A wave of thunder; those who fail the save take the damage and are pushed 10 ft, half damage on a success.' },
];

/** A spell by id or (case-insensitive) name. */
export function findSpell(idOrName: string): Spell | undefined {
  const key = idOrName.trim().toLowerCase();
  return SPELLS.find((s) => s.id === key || s.name.toLowerCase() === key);
}

export function spellsById(ids: string[]): Spell[] {
  return ids.map((id) => {
    const s = findSpell(id);
    if (!s) throw new Error(`Unknown spell "${id}"`);
    return { ...s };
  });
}
