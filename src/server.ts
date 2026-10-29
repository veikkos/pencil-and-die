import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getSetting, openDb, setSetting } from './db.ts';
import { meetsDc, parseDice, physicalDice, scoreRoll } from './dice.ts';
import { levelUp, type LevelChoices } from './levels.ts';
import { announceToolChanges, createMcpServer } from './mcp.ts';
import { buildCharacter, CLASSES, PRESETS, RACES, SKILLS, type CharacterChoices } from './rules.ts';
import { sheetOf } from './sheet.ts';
import { playerView, type MessageKind } from './state.ts';
import { GameStore, type Language } from './store.ts';

const PORT = Number(process.env.PORT ?? 4242);
const HOST = process.env.HOST ?? '127.0.0.1';
const DB_PATH = process.env.DB_PATH ?? fileURLToPath(new URL('../data/game.db', import.meta.url));

const db = openDb(DB_PATH);
const store = new GameStore(db);
const app = createMcpExpressApp({ host: HOST });
const toolNotice = await announceToolChanges(store, db);
if (toolNotice) console.log(toolNotice);

app.use(express.json({ limit: '2mb' }));
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));

// ---- MCP (Claude the DM) ---------------------------------------------------

app.post('/mcp', async (req, res) => {
  // Stateless: a fresh server per request; all state lives in the store.
  const server = createMcpServer(store, db);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const methodNotAllowed = (_req: Request, res: Response) => {
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
};
app.get('/mcp', methodNotAllowed);
app.delete('/mcp', methodNotAllowed);

// ---- Table API (the web page) ----------------------------------------------

const game = (req: Request) => {
  const id = String(req.params.id);
  store.requireGame(id);
  return id;
};

// The settings here are the defaults for new adventures; each adventure's own come with its state.
app.get('/api/config', (_req, res) => {
  res.json({ ...store.settings(), activeGameId: store.activeGameId() ?? null, games: store.listGames() });
});

/** A setting change names its adventure with `gameId`; without one it changes the defaults. */
const settingGame = (req: Request) => {
  const id = req.body.gameId;
  if (id === undefined || id === null) return undefined;
  store.requireGame(String(id));
  return String(id);
};

app.post('/api/language', (req, res) => {
  const lang = req.body.language as Language;
  if (lang !== 'en' && lang !== 'fi') throw new Error('language must be "en" or "fi"');
  store.setLanguage(lang, settingGame(req));
  res.json({ language: lang });
});

// Table preferences (voice etc.) live in the DB too, not in the browser.
app.get('/api/prefs', (_req, res) => {
  res.json(JSON.parse(getSetting(db, 'prefs') ?? '{}'));
});

app.post('/api/prefs', (req, res) => {
  const prefs = { ...JSON.parse(getSetting(db, 'prefs') ?? '{}'), ...req.body };
  setSetting(db, 'prefs', JSON.stringify(prefs));
  res.json(prefs);
});

app.post('/api/verbosity', (req, res) => {
  const id = settingGame(req);
  store.setVerbosity(Number(req.body.verbosity), id);
  res.json({ verbosity: store.verbosity(id) });
});

app.post('/api/fallen-heroes', (req, res) => {
  const id = settingGame(req);
  store.setFallenHeroes(req.body.fallenHeroes, id);
  res.json({ fallenHeroes: store.fallenHeroes(id) });
});

app.post('/api/complexity', (req, res) => {
  const id = settingGame(req);
  store.setComplexity(req.body.complexity, id);
  res.json({ complexity: store.complexity(id) });
});

app.get('/api/rules', (_req, res) => {
  res.json({
    races: RACES.map(({ id, name, blurb, bonuses, speed, traits }) => ({ id, name, blurb, bonuses, speed, traits })),
    classes: CLASSES.map(({ id, name, blurb, hitDie, priority }) => ({ id, name, blurb, hitDie, primary: priority[0] })),
    presets: PRESETS.map(({ id, name, blurb }) => ({ id, name, blurb })),
    skills: SKILLS,
  });
});

app.post('/api/games', (req, res) => {
  const title = String(req.body.title ?? '').trim();
  if (!title) throw new Error('Give the adventure a name');
  res.json(store.createGame(title));
});

app.post('/api/games/:id/open', (req, res) => {
  store.setActiveGame(game(req));
  res.json({ ok: true });
});

app.get('/api/games/:id/state', (req, res) => {
  const id = game(req);
  const at = req.query.at ? Number(req.query.at) : undefined;
  const s = at ? store.stateAt(id, at) : store.state(id);
  res.json({ ...playerView(s), settings: store.settings(id), latestSeq: store.state(id).seq, dmStatus: store.getDmStatus(id) });
});

app.post('/api/character-preview', (req, res) => {
  const c = buildCharacter('preview', req.body as CharacterChoices);
  res.json({ ...c, sheet: sheetOf(c) });
});

app.post('/api/games/:id/characters', (req, res) => {
  const id = game(req);
  const character = buildCharacter(randomUUID().slice(0, 6), req.body as CharacterChoices);
  store.append(id, { type: 'character_created', character });
  res.json(character);
});

app.post('/api/games/:id/characters/:cid/level-up', (req, res) => {
  const id = game(req);
  const c = store.state(id).characters.find((x) => x.id === req.params.cid);
  if (!c) throw new Error('No such character');
  if (!c.pendingLevel) throw new Error(`${c.name} has no level up waiting`);
  const gains = levelUp(c, (req.body ?? {}) as LevelChoices);
  store.append(id, { type: 'character_levelled', characterId: c.id, gains, by: 'player' });
  res.json({ ok: true });
});

app.post('/api/games/:id/start', (req, res) => {
  const id = game(req);
  const s = store.state(id);
  if (!s.characters.length) throw new Error('Create at least one character first');
  if (!s.started) store.append(id, { type: 'game_started' });
  res.json({ ok: true });
});

const PLAYER_KINDS: MessageKind[] = ['action', 'speech', 'question', 'ooc'];

app.post('/api/games/:id/messages', (req, res) => {
  const id = game(req);
  const { characterId, kind, text } = req.body as { characterId?: string; kind: MessageKind; text: string };
  if (!PLAYER_KINDS.includes(kind)) throw new Error(`kind must be one of ${PLAYER_KINDS.join(', ')}`);
  if (!String(text ?? '').trim()) throw new Error('Say something');
  if (characterId && !store.state(id).characters.some((c) => c.id === characterId)) throw new Error('Unknown character');
  const ev = store.append(id, { type: 'message', from: 'player', characterId, kind, text: String(text).trim() });
  res.json({ seq: ev.seq });
});

app.post('/api/games/:id/rolls/:rollId', (req, res) => {
  const id = game(req);
  const roll = store.state(id).pendingRolls.find((r) => r.rollId === req.params.rollId);
  if (!roll) throw new Error('That roll is no longer pending');
  const faces = (req.body.faces as unknown[]).map(Number);
  const out = scoreRoll(parseDice(roll.dice), roll.advantage, roll.modifier, faces);
  const success = meetsDc(roll, out.faces, out.total);
  const ev = store.append(id, { type: 'roll_resolved', rollId: roll.rollId, faces: out.faces, total: out.total, success });
  res.json({ ...out, success, seq: ev.seq });
});

app.get('/api/dice/:notation', (req, res) => {
  const advantage = (req.query.advantage as 'none' | 'advantage' | 'disadvantage') ?? 'none';
  res.json(physicalDice(parseDice(req.params.notation), advantage));
});

/** Timeline for the rewind drawer: the moments players care about. */
app.get('/api/games/:id/history', (req, res) => {
  const id = game(req);
  const s = store.state(id);
  const name = (cid?: string) => s.characters.find((c) => c.id === cid)?.name;
  const rollOf = new Map<string, { label: string; purpose?: string }>();
  const entries = store.liveEvents(id).flatMap(({ seq, at, event: e }) => {
    switch (e.type) {
      case 'message': return [{ seq, at, type: e.from === 'dm' ? 'dm' : 'player', kind: e.kind, who: e.from === 'dm' ? null : name(e.characterId), text: e.text }];
      case 'roll_requested':
        rollOf.set(e.roll.rollId, { label: e.roll.label, purpose: e.roll.purpose });
        return [{ seq, at, type: 'rollRequested', who: name(e.roll.characterId), text: e.roll.label, purpose: e.roll.purpose }];
      case 'roll_resolved': {
        // `label` and `result` let the page name engine rolls (initiative, death saves) in its own language.
        const r = rollOf.get(e.rollId);
        const result = `${e.faces.join(' & ')} → ${e.total}`;
        return [{ seq, at, type: 'roll', text: `${r?.label ?? ''}: ${result}`, label: r?.label ?? '', result, purpose: r?.purpose }];
      }
      case 'character_created': return [{ seq, at, type: 'character', who: e.character.name, text: `${e.character.race} ${e.character.className}` }];
      case 'sketch': return [{ seq, at, type: 'sketch', text: e.caption }];
      case 'scene_set': return [{ seq, at, type: 'scene', text: e.title }];
      case 'game_started': return [{ seq, at, type: 'started', text: '' }];
      default: return [];
    }
  });
  res.json(entries);
});

app.post('/api/games/:id/rewind', (req, res) => {
  const id = game(req);
  const s = store.rewind(id, Number(req.body.seq));
  res.json({ seq: s.seq });
});

// One stream for everything; the page re-fetches what it needs.
app.get('/api/stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const onChange = (gameId: string) => send({ type: 'change', gameId });
  const onActive = (gameId: string) => send({ type: 'active', gameId });
  // An adventure's change is also the new default, so the lobby takes every one.
  const onSettings = (gameId?: string) => send({ type: 'settings', gameId: gameId ?? null, settings: store.settings(gameId) });
  store.changes.on('settings', onSettings);
  store.changes.on('change', onChange);
  store.changes.on('active', onActive);
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.on('close', () => {
    clearInterval(ping);
    store.changes.off('change', onChange);
    store.changes.off('active', onActive);
    store.changes.off('settings', onSettings);
  });
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  res.status(400).json({ error: err.message });
});

app.listen(PORT, HOST, () => {
  console.log(`D&D table:   http://localhost:${PORT}`);
  console.log(`MCP for DM:  http://localhost:${PORT}/mcp`);
  console.log(`Connect:     claude mcp add --transport http dnd http://localhost:${PORT}/mcp`);
});
