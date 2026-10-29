import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { planRoundStart } from './combat.ts';
import { getSetting, setSetting, type Db } from './db.ts';
import { replay, apply, type GameEvent, type GameState, type StoredEvent } from './state.ts';

export type DmStatus = 'offline' | 'listening' | 'thinking';
export type Language = 'en' | 'fi';

export const LANGUAGE_NAMES: Record<Language, string> = { en: 'English', fi: 'Finnish (suomi)' };

export const VERBOSITY_LEVELS = [1, 2, 3, 4] as const;
export type Verbosity = (typeof VERBOSITY_LEVELS)[number];

export const VERBOSITY_GUIDE: Record<Verbosity, string> = {
  1: 'VERBOSITY 1/4 (terse): 1–2 short sentences per beat. Only what changed and what the players need to act. No scenery unless asked.',
  2: 'VERBOSITY 2/4 (brief): 2–3 sentences per beat. One telling detail, then hand the spotlight back.',
  3: 'VERBOSITY 3/4 (normal): 2–5 vivid sentences per beat, then hand the spotlight back with a question.',
  4: 'VERBOSITY 4/4 (rich): 4–8 sentences per beat. Paint the scene with sound, smell and light, give NPCs distinct voices and lines of dialogue, linger on dramatic moments.',
};

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

export const FALLEN_MODES = ['knockout', 'death'] as const;
export type FallenMode = (typeof FALLEN_MODES)[number];

export const FALLEN_GUIDE: Record<FallenMode, string> = {
  knockout: 'WHEN A HERO FALLS: knocked out, not killed. When the fight is over, the hero wakes with 1 HP. ' +
    'Narrate a cost that fits the story: captured, robbed of an item, a lasting injury, the enemy escapes or gains ground. ' +
    'Record it with update_character or a DM note.',
  death: 'WHEN A HERO FALLS: a hero who fails three death saves dies. Narrate the death with care and weight, and give the table a moment. ' +
    'Healing no longer helps the dead; only story magic does, and that is your call (update_character with revive).',
};

/** Events the DM needs to react to. Everything else originates from the DM itself. */
export function isPlayerEvent(e: GameEvent): boolean {
  return (e.type === 'message' && e.from === 'player')
    || (e.type === 'roll_resolved' && !e.byDm)
    || e.type === 'character_created'
    || e.type === 'hero_fell'
    || (e.type === 'character_levelled' && e.by === 'player')
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
    // The adventure keeps the defaults it started with, whatever they become later.
    const start = this.settings();
    for (const [key, value] of [['language', start.language], ['complexity', start.complexity], ['verbosity', String(start.verbosity)], ['fallen_heroes', start.fallenHeroes]]) {
      setSetting(this.db, `${key}:${id}`, value);
    }
    // get_game_state tells the DM where a new adventure starts; notices are only for changes.
    setSetting(this.db, `dm_complexity:${id}`, start.complexity);
    setSetting(this.db, `dm_verbosity:${id}`, String(start.verbosity));
    this.append(id, { type: 'game_created', title });
    this.setActiveGame(id);
    return this.state(id);
  }

  /**
   * Table settings belong to an adventure. Without a game id they are the defaults: what a new
   * adventure starts with, and what the lobby shows. Changing an adventure's setting makes it the
   * default too. Adventures from before settings were per adventure follow the defaults.
   */
  private setting(key: string, gameId?: string): string | undefined {
    return (gameId && getSetting(this.db, `${key}:${gameId}`)) || getSetting(this.db, key);
  }

  private putSetting(key: string, value: string, gameId?: string): void {
    if (gameId) setSetting(this.db, `${key}:${gameId}`, value);
    setSetting(this.db, key, value);
  }

  settings(gameId?: string): { language: Language; complexity: Complexity; verbosity: Verbosity; fallenHeroes: FallenMode } {
    return { language: this.language(gameId), complexity: this.complexity(gameId), verbosity: this.verbosity(gameId), fallenHeroes: this.fallenHeroes(gameId) };
  }

  language(gameId?: string): Language {
    return this.setting('language', gameId) === 'fi' ? 'fi' : 'en';
  }

  setLanguage(lang: Language, gameId?: string): void {
    if (lang === this.language(gameId)) return;
    this.putSetting('language', lang, gameId);
    if (gameId) this.notifyDm(gameId, `LANGUAGE: the table switched to ${LANGUAGE_NAMES[lang]}. From now on write everything the players see (narration, answers, roll labels, scene titles, sketch labels) in ${LANGUAGE_NAMES[lang]}.`);
    this.changes.emit('settings', gameId);
  }

  complexity(gameId?: string): Complexity {
    const c = this.setting('complexity', gameId) as Complexity | undefined;
    return c && COMPLEXITY_LEVELS.includes(c) ? c : 'beginner';
  }

  setComplexity(level: Complexity, gameId?: string): void {
    if (!COMPLEXITY_LEVELS.includes(level)) throw new Error(`complexity must be one of ${COMPLEXITY_LEVELS.join(', ')}`);
    if (level === this.complexity(gameId)) return;
    // Players flip this to peek at the numbers and back, so the DM isn't woken for it;
    // it hears about the level that stuck with the next player input (see takeNotices).
    this.putSetting('complexity', level, gameId);
    this.changes.emit('settings', gameId);
  }

  verbosity(gameId?: string): Verbosity {
    const v = Number(this.setting('verbosity', gameId));
    return (VERBOSITY_LEVELS as readonly number[]).includes(v) ? (v as Verbosity) : 3;
  }

  setVerbosity(level: number, gameId?: string): void {
    if (!(VERBOSITY_LEVELS as readonly number[]).includes(level)) throw new Error('verbosity must be 1–4');
    if (level === this.verbosity(gameId)) return;
    // Like complexity, the DM learns the level that stuck with the next player input.
    this.putSetting('verbosity', String(level), gameId);
    this.changes.emit('settings', gameId);
  }

  fallenHeroes(gameId?: string): FallenMode {
    const m = this.setting('fallen_heroes', gameId);
    return (FALLEN_MODES as readonly string[]).includes(m ?? '') ? (m as FallenMode) : 'knockout';
  }

  setFallenHeroes(mode: FallenMode, gameId?: string): void {
    if (!FALLEN_MODES.includes(mode)) throw new Error(`fallenHeroes must be one of ${FALLEN_MODES.join(', ')}`);
    if (mode === this.fallenHeroes(gameId)) return;
    this.putSetting('fallen_heroes', mode, gameId);
    if (gameId) this.notifyDm(gameId, FALLEN_GUIDE[mode]);
    this.changes.emit('settings', gameId);
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

  /** The adventure the DM last knew it was running, to tell it when the table switched. */
  dmGame(): string | undefined {
    return getSetting(this.db, 'dm_game');
  }

  setDmGame(id: string): void {
    setSetting(this.db, 'dm_game', id);
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
    const before = this.state(gameId);
    // seq keeps growing across rewinds so rewound history is never overwritten.
    const { next } = this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE game_id = ?').get(gameId) as { next: number };
    this.db.prepare('INSERT INTO events (game_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(gameId, next, event.type, JSON.stringify(event), at);
    this.db.prepare('UPDATE games SET updated_at = ? WHERE id = ?').run(at, gameId);
    const stored = { seq: next, at, event };
    const cached = this.cache.get(gameId);
    if (cached) this.cache.set(gameId, apply(cached, stored));
    this.changes.emit('change', gameId, stored);
    this.settle(gameId, before);
    return stored;
  }

  /**
   * Follow-up events the engine owes after the last event, whether it was just appended or
   * a rewind cut the log right after it. `before` is the state just before that event.
   */
  private settle(gameId: string, before: GameState): void {
    // The reducer may not read settings, so the outcome of a third failed save is recorded as its own event.
    const fallen = this.state(gameId).characters.find((c) => c.status === 'dying' && c.deathSaves.failures >= 3);
    if (fallen) this.append(gameId, { type: 'hero_fell', characterId: fallen.id, outcome: this.fallenHeroes(gameId) === 'death' ? 'dead' : 'knocked_out' });
    // However round 1 opens (a tool, a roll from the page, a cancel), a dying hero first up gets a death save.
    for (const follow of planRoundStart(before, this.state(gameId))) this.append(gameId, follow);
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
    // The cut may fall between an event and the follow-ups it caused; owe them again, decided now.
    const live = this.liveEvents(gameId);
    this.settle(gameId, replay(gameId, live.slice(0, -1)));
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
    const level = this.complexity(gameId);
    if (getSetting(this.db, `dm_complexity:${gameId}`) !== level) {
      setSetting(this.db, `dm_complexity:${gameId}`, level);
      notices.push(`COMPLEXITY is ${level}. ${COMPLEXITY_GUIDE[level]}`);
    }
    const verbosity = String(this.verbosity(gameId));
    if ((getSetting(this.db, `dm_verbosity:${gameId}`) ?? '3') !== verbosity) {
      setSetting(this.db, `dm_verbosity:${gameId}`, verbosity);
      notices.push(VERBOSITY_GUIDE[this.verbosity(gameId)]);
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
            this.changes.off('active', onActive);
            signal?.removeEventListener('abort', done);
            resolve();
          };
          const onChange = (id: string, ev: StoredEvent | null) => { if (id === gameId && ev && isPlayerEvent(ev.event)) done(); };
          const onNotice = (id: string) => { if (id === gameId) done(); };
          // The table opened another adventure: stop waiting on this one.
          const onActive = (id: string) => { if (id !== gameId) done(); };
          const timer = setTimeout(done, timeoutMs);
          this.changes.on('change', onChange);
          this.changes.on('notice', onNotice);
          this.changes.on('active', onActive);
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
