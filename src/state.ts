import { addEntry, beginIfReady, entryName, nextTurn, sameRef, type Combat, type CombatEntry } from './combat.ts';
import type { Advantage } from './dice.ts';
import { applyDeathSave, applyHpChange, wakeUp } from './life.ts';
import { restCharacter, useResource, withDefaults, type Recharge } from './resources.ts';
import { applyPresencePatch, healthWord, publicPresence, type Presence, type PresencePatch } from './roster.ts';
import type { Character } from './rules.ts';

export type Speaker = 'dm' | 'player' | 'system';
export type MessageKind = 'narration' | 'action' | 'speech' | 'question' | 'answer' | 'ooc' | 'info';

export interface LogEntry {
  seq: number;
  at: string;
  from: Speaker;
  characterId?: string;
  kind: MessageKind;
  text: string;
  /** System entries are structured so the page can render them in its own language. */
  sys?: { code: string; params: Record<string, unknown> };
}

export interface RollRequest {
  rollId: string;
  characterId: string;
  label: string;
  dice: string;
  modifier: number;
  advantage: Advantage;
  dc?: number;
  /** Players don't see the DC when hidden. */
  hideDc: boolean;
  purpose?: 'initiative' | 'death_save';
  requestedSeq: number;
}

export interface RollResult extends RollRequest {
  faces: number[];
  total: number;
  success?: boolean;
  resolvedSeq: number;
  /** True when the DM rolled it virtually (monsters, secret checks). */
  byDm: boolean;
}

export interface Sketch {
  seq: number;
  caption: string;
  svg: string;
}

export interface GameState {
  id: string;
  title: string;
  seq: number;
  scene: { title: string; description: string; seq: number } | null;
  characters: Character[];
  /** Creatures in the scene (never the heroes). */
  present: Presence[];
  combat: Combat | null;
  log: LogEntry[];
  pendingRolls: RollRequest[];
  rolls: RollResult[];
  sketches: Sketch[];
  dmNotes: { seq: number; text: string }[];
  started: boolean;
}

export interface CharacterPatch {
  hpDelta?: number;
  hp?: number;
  maxHp?: number;
  tempHp?: number;
  ac?: number;
  level?: number;
  xpDelta?: number;
  goldDelta?: number;
  addItems?: { name: string; qty?: number }[];
  removeItems?: { name: string; qty?: number }[];
  addConditions?: string[];
  removeConditions?: string[];
  addFeatures?: string[];
  notes?: string;
  resourceMax?: { resourceId: string; max: number }[];
  /** Damage was a critical hit: a dying hero takes two death save failures. */
  critical?: boolean;
  /** Lets healing raise the dead. */
  revive?: boolean;
}

export type GameEvent =
  | { type: 'game_created'; title: string }
  | { type: 'character_created'; character: Character }
  | { type: 'character_updated'; characterId: string; patch: CharacterPatch; reason?: string }
  | { type: 'resource_used'; characterId: string; resourceId: string; amount: number }
  | { type: 'rest'; kind: Recharge; characterIds: string[] }
  | { type: 'hero_fell'; characterId: string; outcome: 'dead' | 'knocked_out' }
  | { type: 'game_started' }
  | { type: 'message'; from: Speaker; characterId?: string; kind: MessageKind; text: string }
  | { type: 'roll_requested'; roll: Omit<RollRequest, 'requestedSeq'> }
  | { type: 'roll_resolved'; rollId: string; faces: number[]; total: number; success?: boolean; byDm?: boolean }
  | { type: 'roll_cancelled'; rollId: string }
  | { type: 'dm_roll'; roll: Omit<RollResult, 'requestedSeq' | 'resolvedSeq'>; secret: boolean }
  | { type: 'scene_set'; title: string; description: string; present?: Presence[] }
  | { type: 'presence_added'; presences: Presence[] }
  | { type: 'presence_updated'; presenceId: string; patch: PresencePatch; reason?: string }
  | { type: 'presence_removed'; presenceIds: string[] }
  | { type: 'combat_started'; order: CombatEntry[] }
  | { type: 'turn_advanced' }
  | { type: 'combatant_added'; entry: CombatEntry }
  | { type: 'combat_ended' }
  | { type: 'sketch'; caption: string; svg: string }
  | { type: 'dm_note'; text: string };

export interface StoredEvent {
  seq: number;
  at: string;
  event: GameEvent;
}

export function emptyState(id: string): GameState {
  return { id, title: '', seq: 0, scene: null, characters: [], present: [], combat: null, log: [], pendingRolls: [], rolls: [], sketches: [], dmNotes: [], started: false };
}

const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);

function applyPatch(c: Character, p: CharacterPatch): Character {
  const next: Character = { ...c, inventory: c.inventory.map((i) => ({ ...i })), conditions: [...c.conditions], features: [...c.features], resources: c.resources.map((r) => ({ ...r })) };
  if (p.maxHp !== undefined) next.maxHp = p.maxHp;
  if (p.hp !== undefined) next.hp = p.hp;
  if (p.hpDelta !== undefined) {
    let delta = p.hpDelta;
    if (delta < 0 && next.tempHp > 0) {
      const absorbed = Math.min(next.tempHp, -delta);
      next.tempHp -= absorbed;
      delta += absorbed;
    }
    next.hp += delta;
  }
  next.hp = Math.max(0, Math.min(next.maxHp, next.hp));
  const lived = applyHpChange(c, next, p);
  next.hp = lived.hp;
  next.status = lived.status;
  next.deathSaves = lived.deathSaves;
  next.conditions = lived.conditions;
  if (p.tempHp !== undefined) next.tempHp = Math.max(0, p.tempHp);
  if (p.ac !== undefined) next.ac = p.ac;
  if (p.level !== undefined) next.level = p.level;
  if (p.xpDelta) next.xp += p.xpDelta;
  if (p.goldDelta) next.gold = Math.max(0, next.gold + p.goldDelta);
  for (const item of p.addItems ?? []) {
    const existing = next.inventory.find((i) => i.name.toLowerCase() === item.name.toLowerCase());
    if (existing) existing.qty += item.qty ?? 1;
    else next.inventory.push({ name: item.name, qty: item.qty ?? 1 });
  }
  for (const item of p.removeItems ?? []) {
    const existing = next.inventory.find((i) => i.name.toLowerCase() === item.name.toLowerCase());
    if (existing) existing.qty -= item.qty ?? existing.qty;
  }
  next.inventory = next.inventory.filter((i) => i.qty > 0);
  for (const cond of p.addConditions ?? []) if (!next.conditions.includes(cond)) next.conditions.push(cond);
  next.conditions = next.conditions.filter((cnd) => !(p.removeConditions ?? []).includes(cnd));
  for (const f of p.addFeatures ?? []) if (!next.features.includes(f)) next.features.push(f);
  if (p.notes !== undefined) next.notes = p.notes;
  for (const m of p.resourceMax ?? []) {
    const r = next.resources.find((x) => x.id === m.resourceId);
    if (r) { r.max = Math.max(0, m.max); r.used = Math.min(r.used, r.max); }
  }
  return next;
}

type PatchPart = [code: string, value: string | number];

function describePatch(before: Character, after: Character): PatchPart[] {
  const parts: PatchPart[] = [];
  if (after.hp !== before.hp) parts.push(['hp', `${before.hp} → ${after.hp}`]);
  if (after.status !== before.status) parts.push(['status', after.status]);
  if (after.maxHp !== before.maxHp) parts.push(['maxHp', after.maxHp]);
  if (after.tempHp !== before.tempHp) parts.push(['tempHp', after.tempHp]);
  if (after.ac !== before.ac) parts.push(['ac', after.ac]);
  if (after.level !== before.level) parts.push(['level', after.level]);
  if (after.xp !== before.xp) parts.push(['xp', sign(after.xp - before.xp)]);
  if (after.gold !== before.gold) parts.push(['gold', sign(after.gold - before.gold)]);
  const beforeItems = new Map(before.inventory.map((i) => [i.name, i.qty]));
  const afterItems = new Map(after.inventory.map((i) => [i.name, i.qty]));
  for (const [n, q] of afterItems) if ((beforeItems.get(n) ?? 0) < q) parts.push(['gained', n]);
  for (const [n, q] of beforeItems) if ((afterItems.get(n) ?? 0) < q) parts.push(['lost', n]);
  for (const c of after.conditions) if (!before.conditions.includes(c)) parts.push(['condOn', c]);
  for (const c of before.conditions) if (!after.conditions.includes(c)) parts.push(['condOff', c]);
  for (const f of after.features) if (!before.features.includes(f)) parts.push(['feature', f]);
  for (const r of after.resources) {
    const old = before.resources.find((x) => x.id === r.id);
    if (old && (old.used !== r.used || old.max !== r.max)) parts.push(['resource', `${r.name} ${r.max - r.used}/${r.max}`]);
  }
  return parts;
}

/** Pure reducer: folding all live events in order yields the game state. */
export function apply(state: GameState, { seq, at, event: e }: StoredEvent): GameState {
  const s: GameState = { ...state, seq };
  const sys = (code: string, params: Record<string, unknown>, text: string) => {
    s.log = [...s.log, { seq, at, from: 'system', kind: 'info', text, sys: { code, params } }];
  };
  const nameOf = (id: string) => s.characters.find((c) => c.id === id)?.name ?? 'Someone';
  /** Takes the gathering combat; once every initiative is in, fixes the order and announces it. */
  const gathered = (c: Combat) => {
    s.combat = beginIfReady(s, c);
    if (s.combat.round === 0) return;
    const names = s.combat.order.map((x) => entryName(s, x));
    sys('combatOrder', { names }, `Turn order: ${names.join(', ')}.`);
  };

  switch (e.type) {
    case 'game_created':
      s.title = e.title;
      break;
    case 'character_created':
      const created = withDefaults(e.character);
      s.characters = [...s.characters, created];
      sys('joined', { name: created.name, race: created.race, cls: created.className },
        `${created.name} the ${created.race} ${created.className} joins the party.`);
      break;
    case 'character_updated': {
      const before = s.characters.find((c) => c.id === e.characterId);
      if (!before) break;
      const after = applyPatch(before, e.patch);
      s.characters = s.characters.map((c) => (c.id === e.characterId ? after : c));
      const parts = describePatch(before, after);
      if (parts.length) {
        sys('updated', { name: after.name, parts, reason: e.reason },
          `${after.name}: ${parts.map(([k, v]) => `${k} ${v}`).join(', ')}${e.reason ? ` (${e.reason})` : ''}`);
      }
      break;
    }
    case 'resource_used': {
      const before = s.characters.find((c) => c.id === e.characterId);
      if (!before) break;
      const after = useResource(before, e.resourceId, e.amount);
      s.characters = s.characters.map((c) => (c.id === e.characterId ? after : c));
      const parts = describePatch(before, after);
      sys('updated', { name: after.name, parts }, `${after.name}: ${parts.map(([k, v]) => `${k} ${v}`).join(', ')}`);
      break;
    }
    case 'rest':
      s.characters = s.characters.map((c) => (e.characterIds.includes(c.id) ? longRest(c, e.kind) : c));
      sys('rest', { kind: e.kind, names: e.characterIds.map(nameOf) }, `${e.characterIds.map(nameOf).join(', ')} take a ${e.kind} rest.`);
      break;
    case 'hero_fell': {
      const hero = s.characters.find((c) => c.id === e.characterId);
      if (!hero) break;
      s.characters = s.characters.map((c) => (c.id === e.characterId ? { ...c, hp: 0, status: e.outcome === 'dead' ? 'dead' : 'out' } : c));
      sys('fell', { name: hero.name, outcome: e.outcome },
        e.outcome === 'dead' ? `${hero.name} has died.` : `${hero.name} is knocked out.`);
      break;
    }
    case 'game_started':
      s.started = true;
      sys('started', {}, 'The adventure begins.');
      break;
    case 'message':
      s.log = [...s.log, { seq, at, from: e.from, characterId: e.characterId, kind: e.kind, text: e.text }];
      break;
    case 'roll_requested':
      s.pendingRolls = [...s.pendingRolls, { ...e.roll, requestedSeq: seq }];
      break;
    case 'roll_resolved': {
      const req = s.pendingRolls.find((r) => r.rollId === e.rollId);
      if (!req) break;
      s.pendingRolls = s.pendingRolls.filter((r) => r.rollId !== e.rollId);
      s.rolls = [...s.rolls, { ...req, faces: e.faces, total: e.total, success: e.success, resolvedSeq: seq, byDm: !!e.byDm }];
      if (req.purpose === 'death_save') {
        s.characters = s.characters.map((c) => (c.id === req.characterId ? applyDeathSave(c, e.faces[0]) : c));
      }
      const outcome = e.success === undefined ? '' : e.success ? ' — success' : ' — failure';
      sys('rolled', { name: nameOf(req.characterId), label: req.label, faces: e.faces, mod: req.modifier, total: e.total, success: e.success, rollSeq: seq },
        `${nameOf(req.characterId)} rolled ${req.label}: ${e.faces.join(' & ')} ${sign(req.modifier)} = ${e.total}${outcome}`);
      if (req.purpose === 'initiative' && s.combat?.round === 0) {
        const order = s.combat.order.map((x) => (x.initiative === null && sameRef(x.ref, { kind: 'hero', id: req.characterId }) ? { ...x, initiative: e.total } : x));
        gathered({ ...s.combat, order });
      }
      break;
    }
    case 'roll_cancelled': {
      const req = s.pendingRolls.find((r) => r.rollId === e.rollId);
      s.pendingRolls = s.pendingRolls.filter((r) => r.rollId !== e.rollId);
      if (req?.purpose === 'initiative' && s.combat?.round === 0) {
        gathered({ ...s.combat, order: s.combat.order.filter((x) => !(x.initiative === null && sameRef(x.ref, { kind: 'hero', id: req.characterId }))) });
      }
      break;
    }
    case 'dm_roll':
      s.rolls = [...s.rolls, { ...e.roll, requestedSeq: seq, resolvedSeq: seq }];
      if (!e.secret) {
        sys('dmRolled', { label: e.roll.label, faces: e.roll.faces, mod: e.roll.modifier, total: e.roll.total },
          `DM rolled ${e.roll.label}: ${e.roll.faces.join(' & ')} ${sign(e.roll.modifier)} = ${e.roll.total}`);
      }
      break;
    case 'scene_set':
      s.scene = { title: e.title, description: e.description, seq };
      if (e.present !== undefined) s.present = e.present;
      break;
    case 'presence_added': {
      s.present = [...s.present, ...e.presences];
      const names = [...new Set(e.presences.map((p) => p.name))];
      sys('arrived', { names }, `${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} here.`);
      break;
    }
    case 'presence_updated': {
      const before = s.present.find((p) => p.id === e.presenceId);
      if (!before) break;
      const after = applyPresencePatch(before, e.patch);
      s.present = s.present.map((p) => (p.id === e.presenceId ? after : p));
      if (after.defeated && !before.defeated) {
        sys('defeated', { name: after.name }, `${after.name} is defeated.`);
        break;
      }
      const params: Record<string, unknown> = { name: after.name };
      const hb = healthWord(before);
      const ha = healthWord(after);
      if (ha !== hb && ha !== undefined) params.health = ha;
      const condOn = after.conditions.filter((c) => !before.conditions.includes(c));
      const condOff = before.conditions.filter((c) => !after.conditions.includes(c));
      if (condOn.length) params.condOn = condOn;
      if (condOff.length) params.condOff = condOff;
      if (after.side !== before.side) params.sideChange = after.side;
      if (Object.keys(params).length > 1) {
        const bits = [params.health && `now ${params.health}`, condOn.length && `${condOn.join(', ')}`, condOff.length && `no longer ${condOff.join(', ')}`, params.sideChange && `now ${params.sideChange}`].filter(Boolean);
        sys('presenceUpdated', params, `${after.name}: ${bits.join(', ')}`);
      }
      break;
    }
    case 'presence_removed': {
      const gone = s.present.filter((p) => e.presenceIds.includes(p.id));
      if (!gone.length) break;
      s.present = s.present.filter((p) => !e.presenceIds.includes(p.id));
      const names = [...new Set(gone.map((p) => p.name))];
      sys('left', { names }, `${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} gone.`);
      break;
    }
    case 'combat_started':
      sys('combatStarted', {}, 'Fight!');
      gathered({ round: 0, turn: 0, order: e.order });
      break;
    case 'turn_advanced': {
      const next = nextTurn(s);
      if (s.combat && next) s.combat = { ...s.combat, ...next };
      break;
    }
    case 'combatant_added':
      if (s.combat) s.combat = addEntry(s.combat, e.entry);
      break;
    case 'combat_ended':
      if (!s.combat) break;
      s.combat = null;
      s.characters = s.characters.map((c) => (c.status === 'out' ? wakeUp(c, 1) : c));
      sys('combatEnded', {}, 'The fight is over.');
      break;
    case 'sketch':
      s.sketches = [...s.sketches, { seq, caption: e.caption, svg: e.svg }];
      break;
    case 'dm_note':
      s.dmNotes = [...s.dmNotes, { seq, text: e.text }];
      break;
  }
  return s;
}

function longRest(c: Character, kind: Recharge): Character {
  const rested = restCharacter(c, kind);
  if (kind === 'short') return rested;
  return c.status === 'dead' ? { ...rested, hp: c.hp } : wakeUp(rested, rested.hp);
}

export function replay(id: string, events: StoredEvent[]): GameState {
  return events.reduce(apply, emptyState(id));
}

/** What the table sees: no DM notes, hidden DCs stripped. */
export function playerView(s: GameState) {
  const hide = <T extends RollRequest>(r: T) => (r.hideDc ? { ...r, dc: undefined } : r);
  return {
    ...s,
    dmNotes: undefined,
    present: s.present.map(publicPresence),
    combat: s.combat && { round: s.combat.round, turn: s.combat.turn, order: s.combat.order.map((e) => ({ ref: e.ref, ready: e.initiative !== null })) },
    pendingRolls: s.pendingRolls.map(hide),
    // DM rolls can be secret; the public ones are already in the log.
    rolls: s.rolls.filter((r) => !r.byDm).map(hide),
  };
}
