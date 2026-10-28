// SRD armour and shields, so the inventory can say how much protection each piece gives.

export interface Armour {
  id: string;
  name: string;
  kind: 'light' | 'medium' | 'heavy' | 'shield';
  /** Base AC; for a shield, what it adds. */
  ac: number;
  /** Most DEX that counts: light armour takes all of it, heavy none. */
  dexMax?: number;
  /** Noisy: disadvantage on Stealth checks while worn. */
  stealth?: boolean;
}

const a = (id: string, name: string, kind: Armour['kind'], ac: number, props: Partial<Armour> = {}): Armour =>
  ({ id, name, kind, ac, ...(kind === 'medium' ? { dexMax: 2 } : kind === 'heavy' ? { dexMax: 0 } : {}), ...props });

export const ARMOUR: Armour[] = [
  a('padded', 'Padded armour', 'light', 11, { stealth: true }),
  a('leather', 'Leather armour', 'light', 11),
  a('studded-leather', 'Studded leather armour', 'light', 12),
  a('hide', 'Hide armour', 'medium', 12),
  a('chain-shirt', 'Chain shirt', 'medium', 13),
  a('scale-mail', 'Scale mail', 'medium', 14, { stealth: true }),
  a('breastplate', 'Breastplate', 'medium', 14),
  a('half-plate', 'Half plate', 'medium', 15, { stealth: true }),
  a('ring-mail', 'Ring mail', 'heavy', 14, { stealth: true }),
  a('chain-mail', 'Chain mail', 'heavy', 16, { stealth: true }),
  a('splint', 'Splint armour', 'heavy', 17, { stealth: true }),
  a('plate', 'Plate armour', 'heavy', 18, { stealth: true }),
  a('shield', 'Shield', 'shield', 2),
];

/** The armour an inventory item is, if any: "Leather armor", "Wooden shield" and "Plate" all count. */
export function armourFor(itemName: string): Armour | undefined {
  const n = itemName.toLowerCase().replace(/\barmou?r\b/, '').replace(/\s+/g, ' ').trim();
  if (/\bshield\b/.test(n)) return ARMOUR.find((x) => x.id === 'shield');
  return ARMOUR.find((x) => x.name.toLowerCase().replace(/\barmou?r\b/, '').trim() === n);
}
