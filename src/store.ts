import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { getSetting, setSetting, type Db } from './db.ts';
import { replay, apply, type GameEvent, type GameState, type StoredEvent } from './state.ts';

export type DmStatus = 'offline' | 'listening' | 'thinking';
export type Language = 'en' | 'fi';

export const LANGUAGE_NAMES: Record<Language, string> = { en: 'English', fi: 'Finnish (suomi)' };

export const COMPLEXITY_LEVELS = ['beginner', 'casual', 'intermediate'] as const;
export type Complexity = (typeof COMPLEXITY_LEVELS)[number];

export const COMPLEXITY_GUIDE: Record<Complexity, string> = {
  beginner: 'BEGINNER table: these players are new to D&D. Never use rules jargon (no "DC", "modifier", "saving throw", "bonus action"); say it in plain words. ' +
    'End each beat by offering 2–3 concrete ideas of what they could do, while making clear anything goes. Ask for few rolls and explain in one short sentence why a roll is needed. ' +
    'Be forgiving: failures make the story funnier or harder, rarely deadly. Keep combat short and describe it cinematically; tell them what their character is good at.',
  casual: 'CASUAL table: players know the basics (roll a d20, higher is better, HP). Use light terms like "check" and "attack", but no deep rules talk. ' +
    'Offer suggestions only when they seem stuck. Normal danger, simple combat with clear turn announcements.',
  intermediate: 'INTERMEDIATE table: players know 5e basics. Use standard terms (DC, advantage, saving throw, bonus action, opportunity attack, spell slots). ' +
    'Do not suggest actions unless asked. Run tactical combat with positioning, real danger and resource management; mention when they use class features well.',
};

export interface GameSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** Events the DM needs to react to. Everything else originates from the DM itself. */
export function isPlayerEvent(e: GameEvent): boolean {
  return (e.type === 'message' && e.from === 'player')
    || (e.type === 'roll_resolved' && !e.byDm)
    || e.type === 'character_created'
    || e.type === 'game_started';
}

export class GameStore {
  readonly changes = new EventEmitter();
  private cache = new Map<string, GameState>();
  private dmStatus = new Map<string, DmStatus>();
  private dmIdleTimers = new Map<string, NodeJS.Timeout>();
  private db: Db;

  constructor(db: Db) {
    this.db = db;
    this.changes.setMaxListeners(100);
  }

  listGames(): GameSummary[] {
    return (this.db.prepare('SELECT id, title, created_at, updated_at FROM games ORDER BY updated_at DESC').all() as any[])
      .map((r) => ({ id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at }));
  }

  createGame(title: string): GameState {
    const id = randomUUID().slice(0, 8);
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO games (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, title, now, now);
    this.append(id, { type: 'game_created', title });
    this.setActiveGame(id);
    return this.state(id);
  }

  language(): Language {
    return getSetting(this.db, 'language') === 'fi' ? 'fi' : 'en';
  }

  setLanguage(lang: Language): void {
    if (lang === this.language()) return;
    setSetting(this.db, 'language', lang);
    const active = this.activeGameId();
    if (active) this.notifyDm(active, `LANGUAGE: the table switched to ${LANGUAGE_NAMES[lang]}. From now on write everything the players see (narration, answers, roll labels, scene titles, sketch labels) in ${LANGUAGE_NAMES[lang]}.`);
    this.changes.emit('language', lang);
  }

  complexity(): Complexity {
    const c = getSetting(this.db, 'complexity') as Complexity | undefined;
    return c && COMPLEXITY_LEVELS.includes(c) ? c : 'beginner';
  }

  setComplexity(level: Complexity): void {
    if (!COMPLEXITY_LEVELS.includes(level)) throw new Error(`complexity must be one of ${COMPLEXITY_LEVELS.join(', ')}`);
    if (level === this.complexity()) return;
    // Players flip this to peek at the numbers and back, so the DM isn't woken for it;
    // it hears about the level that stuck with the next player input (see takeNotices).
    setSetting(this.db, 'complexity', level);
    this.changes.emit('complexity', level);
  }

  activeGameId(): string | undefined {
    const id = getSetting(this.db, 'active_game');
    if (id && this.exists(id)) return id;
    return this.listGames()[0]?.id;
  }

  setActiveGame(id: string): void {
    this.requireGame(id);
    setSetting(this.db, 'active_game', id);
    this.changes.emit('active', id);
  }

  exists(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM games WHERE id = ?').get(id);
  }

  requireGame(id: string): void {
    if (!this.exists(id)) throw new Error(`No game with id "${id}"`);
  }

  liveEvents(gameId: string, afterSeq = 0): StoredEvent[] {
    return (this.db.prepare('SELECT seq, type, payload, created_at FROM events WHERE game_id = ? AND seq > ? AND rewound_at IS NULL ORDER BY seq')
      .all(gameId, afterSeq) as any[])
      .map((r) => ({ seq: r.seq, at: r.created_at, event: JSON.parse(r.payload) as GameEvent }));
  }

  state(gameId: string): GameState {
    let s = this.cache.get(gameId);
    if (!s) {
      this.requireGame(gameId);
      s = replay(gameId, this.liveEvents(gameId));
      this.cache.set(gameId, s);
    }
    return s;
  }

  /** The game as it was right after `seq`, for scrubbing the timeline without changing anything. */
  stateAt(gameId: string, seq: number): GameState {
    this.requireGame(gameId);
    return replay(gameId, this.liveEvents(gameId).filter((e) => e.seq <= seq));
  }

  append(gameId: string, event: GameEvent): StoredEvent {
    this.requireGame(gameId);
    const at = new Date().toISOString();
    // seq keeps growing across rewinds so rewound history is never overwritten.
    const { next } = this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE game_id = ?').get(gameId) as { next: number };
    this.db.prepare('INSERT INTO events (game_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(gameId, next, event.type, JSON.stringify(event), at);
    this.db.prepare('UPDATE games SET updated_at = ? WHERE id = ?').run(at, gameId);
    const stored = { seq: next, at, event };
    const cached = this.cache.get(gameId);
    if (cached) this.cache.set(gameId, apply(cached, stored));
    this.changes.emit('change', gameId, stored);
    return stored;
  }

  /** Drops every event after `seq`. They stay in the DB, flagged, for the record. */
  rewind(gameId: string, seq: number): GameState {
    this.requireGame(gameId);
    if (seq < 1) throw new Error('Cannot rewind past the start of the game');
    const before = this.state(gameId).seq;
    if (seq >= before) return this.state(gameId);
    const now = new Date().toISOString();
    this.db.prepare('UPDATE events SET rewound_at = ? WHERE game_id = ? AND seq > ? AND rewound_at IS NULL').run(now, gameId, seq);
    if (this.dmCursor(gameId) > seq) this.setDmCursor(gameId, seq);
    this.cache.delete(gameId);
    const s = this.state(gameId);
    this.notifyDm(gameId, `REWIND: the table rewound the game to seq ${seq}. Everything after it never happened ` +
      `(including your own narration). Call get_game_state, then carry on from that moment.` +
      (s.pendingRolls.length ? ' Pending rolls are open again; wait for their results.' : ''));
    this.changes.emit('change', gameId, null);
    return s;
  }

  dmCursor(gameId: string): number {
    return Number(getSetting(this.db, `dm_cursor:${gameId}`) ?? 0);
  }

  setDmCursor(gameId: string, seq: number): void {
    setSetting(this.db, `dm_cursor:${gameId}`, String(seq));
  }

  /** Out-of-band messages for the DM (rewinds, language changes), delivered by waitForPlayers. */
  notifyDm(gameId: string, notice: string): void {
    setSetting(this.db, `dm_notices:${gameId}`, JSON.stringify([...this.pendingNotices(gameId), notice]));
    this.changes.emit('notice', gameId);
  }

  pendingNotices(gameId: string): string[] {
    return JSON.parse(getSetting(this.db, `dm_notices:${gameId}`) ?? '[]');
  }

  private takeNotices(gameId: string): string[] {
    const notices = this.pendingNotices(gameId);
    if (notices.length) setSetting(this.db, `dm_notices:${gameId}`, '[]');
    const level = this.complexity();
    if (getSetting(this.db, `dm_complexity:${gameId}`) !== level) {
      setSetting(this.db, `dm_complexity:${gameId}`, level);
      notices.push(`COMPLEXITY is ${level}. ${COMPLEXITY_GUIDE[level]}`);
    }
    return notices;
  }

  getDmStatus(gameId: string): DmStatus {
    return this.dmStatus.get(gameId) ?? 'offline';
  }

  /** Any DM tool call counts as a sign of life; silence for a while means offline. */
  touchDm(gameId: string, status: DmStatus = 'thinking'): void {
    clearTimeout(this.dmIdleTimers.get(gameId));
    this.dmIdleTimers.set(gameId, setTimeout(() => this.setDmStatus(gameId, 'offline'), 5 * 60_000).unref());
    this.setDmStatus(gameId, status);
  }

  setDmStatus(gameId: string, status: DmStatus): void {
    if (this.getDmStatus(gameId) === status) return;
    this.dmStatus.set(gameId, status);
    this.changes.emit('change', gameId, null);
  }

  unseenPlayerEvents(gameId: string): StoredEvent[] {
    return this.liveEvents(gameId, this.dmCursor(gameId)).filter((e) => isPlayerEvent(e.event));
  }

  private hasNews(gameId: string): boolean {
    return this.unseenPlayerEvents(gameId).length > 0 || this.pendingNotices(gameId).length > 0;
  }

  /**
   * Long-poll for player input. Returns as soon as something arrives, after a short
   * settle period so several players typing at once land in one batch.
   */
  async waitForPlayers(gameId: string, timeoutMs: number, settleMs = 2500, signal?: AbortSignal): Promise<{ events: StoredEvent[]; notices: string[] }> {
    this.requireGame(gameId);
    clearTimeout(this.dmIdleTimers.get(gameId));
    this.setDmStatus(gameId, 'listening');
    let events: StoredEvent[] = [];
    try {
      if (!this.hasNews(gameId)) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            this.changes.off('change', onChange);
            this.changes.off('notice', onNotice);
            signal?.removeEventListener('abort', done);
            resolve();
          };
          const onChange = (id: string, ev: StoredEvent | null) => { if (id === gameId && ev && isPlayerEvent(ev.event)) done(); };
          const onNotice = (id: string) => { if (id === gameId) done(); };
          const timer = setTimeout(done, timeoutMs);
          this.changes.on('change', onChange);
          this.changes.on('notice', onNotice);
          signal?.addEventListener('abort', done);
        });
        if (this.hasNews(gameId) && settleMs > 0 && !signal?.aborted) {
          await new Promise((r) => setTimeout(r, settleMs));
        }
      }
      const notices = this.takeNotices(gameId);
      events = this.unseenPlayerEvents(gameId);
      if (events.length) this.setDmCursor(gameId, this.state(gameId).seq);
      return { events, notices };
    } finally {
      if (signal?.aborted) this.setDmStatus(gameId, 'offline');
      else this.touchDm(gameId, events.length ? 'thinking' : 'listening');
    }
  }
}
