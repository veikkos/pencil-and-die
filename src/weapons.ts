// SRD simple and martial weapons. A hero can attack with any of these they carry.

export type DamageType = 'slashing' | 'piercing' | 'bludgeoning';

export interface Weapon {
  id: string;
  name: string;
  damage: string;
  damageType: DamageType;
  kind: 'melee' | 'ranged';
  finesse?: boolean;
  light?: boolean;
  heavy?: boolean;
  twoHanded?: boolean;
  reach?: boolean;
  /** Damage die when held in two hands. */
  versatile?: string;
  /** Normal/long range in feet when thrown. */
  thrown?: string;
  /** Normal/long range in feet for ranged weapons. */
  range?: string;
  /** The inventory item it shoots. */
  ammo?: string;
}

const w = (id: string, name: string, damage: string, damageType: DamageType, kind: Weapon['kind'], props: Partial<Weapon> = {}): Weapon =>
  ({ id, name, damage, damageType, kind, ...props });

export const WEAPONS: Weapon[] = [
  w('club', 'Club', '1d4', 'bludgeoning', 'melee', { light: true }),
  w('dagger', 'Dagger', '1d4', 'piercing', 'melee', { finesse: true, light: true, thrown: '20/60' }),
  w('greatclub', 'Greatclub', '1d8', 'bludgeoning', 'melee', { twoHanded: true }),
  w('handaxe', 'Handaxe', '1d6', 'slashing', 'melee', { light: true, thrown: '20/60' }),
  w('javelin', 'Javelin', '1d6', 'piercing', 'melee', { thrown: '30/120' }),
  w('light-hammer', 'Light hammer', '1d4', 'bludgeoning', 'melee', { light: true, thrown: '20/60' }),
  w('mace', 'Mace', '1d6', 'bludgeoning', 'melee'),
  w('quarterstaff', 'Quarterstaff', '1d6', 'bludgeoning', 'melee', { versatile: '1d8' }),
  w('sickle', 'Sickle', '1d4', 'slashing', 'melee', { light: true }),
  w('spear', 'Spear', '1d6', 'piercing', 'melee', { versatile: '1d8', thrown: '20/60' }),
  w('light-crossbow', 'Light crossbow', '1d8', 'piercing', 'ranged', { twoHanded: true, range: '80/320', ammo: 'Bolts' }),
  w('dart', 'Dart', '1d4', 'piercing', 'ranged', { finesse: true, thrown: '20/60' }),
  w('shortbow', 'Shortbow', '1d6', 'piercing', 'ranged', { twoHanded: true, range: '80/320', ammo: 'Arrows' }),
  w('sling', 'Sling', '1d4', 'bludgeoning', 'ranged', { range: '30/120', ammo: 'Sling bullets' }),
  w('battleaxe', 'Battleaxe', '1d8', 'slashing', 'melee', { versatile: '1d10' }),
  w('flail', 'Flail', '1d8', 'bludgeoning', 'melee'),
  w('glaive', 'Glaive', '1d10', 'slashing', 'melee', { heavy: true, reach: true, twoHanded: true }),
  w('greataxe', 'Greataxe', '1d12', 'slashing', 'melee', { heavy: true, twoHanded: true }),
  w('greatsword', 'Greatsword', '2d6', 'slashing', 'melee', { heavy: true, twoHanded: true }),
  w('halberd', 'Halberd', '1d10', 'slashing', 'melee', { heavy: true, reach: true, twoHanded: true }),
  w('lance', 'Lance', '1d12', 'piercing', 'melee', { reach: true }),
  w('longsword', 'Longsword', '1d8', 'slashing', 'melee', { versatile: '1d10' }),
  w('maul', 'Maul', '2d6', 'bludgeoning', 'melee', { heavy: true, twoHanded: true }),
  w('morningstar', 'Morningstar', '1d8', 'piercing', 'melee'),
  w('pike', 'Pike', '1d10', 'piercing', 'melee', { heavy: true, reach: true, twoHanded: true }),
  w('rapier', 'Rapier', '1d8', 'piercing', 'melee', { finesse: true }),
  w('scimitar', 'Scimitar', '1d6', 'slashing', 'melee', { finesse: true, light: true }),
  w('shortsword', 'Shortsword', '1d6', 'piercing', 'melee', { finesse: true, light: true }),
  w('trident', 'Trident', '1d6', 'piercing', 'melee', { versatile: '1d8', thrown: '20/60' }),
  w('war-pick', 'War pick', '1d8', 'piercing', 'melee'),
  w('warhammer', 'Warhammer', '1d8', 'bludgeoning', 'melee', { versatile: '1d10' }),
  w('whip', 'Whip', '1d4', 'slashing', 'melee', { finesse: true, reach: true }),
  w('hand-crossbow', 'Hand crossbow', '1d6', 'piercing', 'ranged', { light: true, range: '30/120', ammo: 'Bolts' }),
  w('heavy-crossbow', 'Heavy crossbow', '1d10', 'piercing', 'ranged', { heavy: true, twoHanded: true, range: '100/400', ammo: 'Bolts' }),
  w('longbow', 'Longbow', '1d8', 'piercing', 'ranged', { heavy: true, twoHanded: true, range: '150/600', ammo: 'Arrows' }),
];

export const AMMO = [...new Set(WEAPONS.flatMap((x) => (x.ammo ? [x.ammo] : [])))];

/** Item names from before items were data: "2 Handaxes", "Light crossbow + 20 bolts". */
const baseName = (item: string) => item.toLowerCase().replace(/^\d+\s+/, '').split('+')[0].trim();

/** The weapon an inventory item is, if any. */
export function weaponFor(itemName: string): Weapon | undefined {
  const n = baseName(itemName);
  return WEAPONS.find((x) => x.name.toLowerCase() === n || `${x.name.toLowerCase()}s` === n || x.id === n);
}

/** How many of an item an old-style name stands for: "2 Handaxes" → 2. */
export const countIn = (itemName: string) => Number(/^(\d+)\s/.exec(itemName.trim())?.[1] ?? 1);

/** Ammunition carried, counting old names like "Shortbow + 20 arrows". */
export function ammoCount(inventory: { name: string; qty: number }[], ammo: string): number {
  const key = ammo.toLowerCase();
  let n = 0;
  for (const i of inventory) {
    if (i.name.toLowerCase() === key) n += i.qty;
    const bundled = /\+\s*(\d+)\s+(.+)$/.exec(i.name);
    if (bundled && key.startsWith(bundled[2].toLowerCase())) n += Number(bundled[1]) * i.qty;
  }
  return n;
}
