import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDice, scoreRoll } from '../src/dice.ts';
import { checkModifier } from '../src/rules.ts';
import { sanitizeSketch } from '../src/sketch.ts';
import { DM_GUIDE } from '../src/dm-guide.ts';
import { mcpClient, mira, newStore, newTable } from './helpers.ts';


test('dice: advantage keeps the higher d20 and validates faces', () => {
  const d20 = parseDice('1d20');
  assert.equal(scoreRoll(d20, 'advantage', 3, [4, 17]).total, 20);
  assert.equal(scoreRoll(d20, 'disadvantage', 3, [4, 17]).total, 7);
  assert.equal(scoreRoll(parseDice('2d6'), 'none', 2, [3, 5]).total, 10);
  assert.throws(() => scoreRoll(d20, 'none', 0, [21]));
  assert.throws(() => scoreRoll(parseDice('2d6'), 'none', 0, [3]));
  assert.throws(() => parseDice('1d7'));
});

test('rules: character build applies race bonus and computes checks', () => {
  const c = mira();
  assert.equal(c.abilities.dex, 17); // 15 + 2 halfling
  assert.equal(c.ac, 14);            // leather 11 + dex 3
  assert.equal(c.maxHp, 10);         // d8 + con 2 (14)
  assert.deepEqual(checkModifier(c, 'Stealth'), { modifier: 5, label: 'Dexterity (Stealth) check' });
  assert.equal(checkModifier(c, 'hiiviskely', 'fi').label, 'Hiiviskely (Ketteryys) -heitto');
  assert.equal(checkModifier(c, 'dex save').modifier, 5);
});

test('store: rewind drops later events and reopens the roll', () => {
  const store = newStore();
  const g = store.createGame('Test');
  store.append(g.id, { type: 'character_created', character: mira() });
  store.append(g.id, { type: 'roll_requested', roll: { rollId: 'r1', characterId: 'mira', label: 'Stealth', dice: '1d20', modifier: 5, advantage: 'none', dc: 12, hideDc: true } });
  const beforeRoll = store.state(g.id).seq;
  store.append(g.id, { type: 'roll_resolved', rollId: 'r1', faces: [2], total: 7, success: false });
  store.append(g.id, { type: 'character_updated', characterId: 'mira', patch: { hpDelta: -4 } });
  assert.equal(store.state(g.id).characters[0].hp, 6);
  assert.equal(store.state(g.id).pendingRolls.length, 0);

  store.rewind(g.id, beforeRoll);
  const s = store.state(g.id);
  assert.equal(s.characters[0].hp, 10);
  assert.equal(s.pendingRolls[0].rollId, 'r1');
  assert.match(store.pendingNotices(g.id)[0], /REWIND/);

  // New events continue after the rewound ones without clobbering them.
  const next = store.append(g.id, { type: 'roll_resolved', rollId: 'r1', faces: [15], total: 20, success: true });
  assert.ok(next.seq > beforeRoll + 2);
  assert.equal(store.state(g.id).rolls[0].total, 20);
});

test('store: stateAt previews the past without changing the present', () => {
  const store = newStore();
  const g = store.createGame('Test');
  store.append(g.id, { type: 'character_created', character: mira() });
  const at = store.state(g.id).seq;
  store.append(g.id, { type: 'character_updated', characterId: 'mira', patch: { hpDelta: -3 } });
  assert.equal(store.stateAt(g.id, at).characters[0].hp, 10);
  assert.equal(store.state(g.id).characters[0].hp, 7);
});

test('store: waitForPlayers returns player input and advances the cursor', async () => {
  const store = newStore();
  const g = store.createGame('Test');
  store.append(g.id, { type: 'character_created', character: mira() });
  const first = await store.waitForPlayers(g.id, 1000, 0);
  assert.equal(first.events.length, 1);

  const waiting = store.waitForPlayers(g.id, 5000, 0);
  setTimeout(() => store.append(g.id, { type: 'message', from: 'player', characterId: 'mira', kind: 'action', text: 'I listen' }), 20);
  const second = await waiting;
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].event.type, 'message');

  // DM's own events don't wake the DM.
  store.append(g.id, { type: 'message', from: 'dm', kind: 'narration', text: 'You hear snoring.' });
  const third = await store.waitForPlayers(g.id, 50, 0);
  assert.equal(third.events.length, 0);
});

test('store: language change notifies the DM; complexity only reports where it settled', async () => {
  const store = newStore();
  const g = store.createGame('Test');
  store.setLanguage('fi');
  assert.match(store.pendingNotices(g.id)[0], /Finnish/);

  store.setComplexity('intermediate');
  store.setComplexity('beginner');
  store.setComplexity('casual');
  const { notices } = await store.waitForPlayers(g.id, 10, 0);
  assert.equal(notices.filter((n) => n.startsWith('COMPLEXITY')).length, 1);
  assert.match(notices.at(-1)!, /COMPLEXITY is casual/);

  const again = await store.waitForPlayers(g.id, 10, 0);
  assert.equal(again.notices.length, 0);
});

test('sketch: plain drawing allowed, scripts rejected', () => {
  assert.equal(sanitizeSketch('<svg viewBox="0 0 800 500"><path d="M0 0 L10 10"/></svg>'), '<path d="M0 0 L10 10"/>');
  assert.throws(() => sanitizeSketch('<script>alert(1)</script>'));
  assert.throws(() => sanitizeSketch('<path onload="x()"/>'));
  assert.throws(() => sanitizeSketch('<image href="http://x"/>'));
});

test('store: verbosity defaults to 3 and the DM hears where it settled', async () => {
  const store = newStore();
  const g = store.createGame('Test');
  assert.equal(store.verbosity(), 3);
  assert.equal((await store.waitForPlayers(g.id, 10, 0)).notices.filter((n) => n.startsWith('VERBOSITY')).length, 0);
  store.setVerbosity(1);
  store.setVerbosity(4);
  const { notices } = await store.waitForPlayers(g.id, 10, 0);
  assert.deepEqual(notices.filter((n) => n.startsWith('VERBOSITY')).map((n) => n.slice(0, 15)), ['VERBOSITY 4/4 (']);
  assert.throws(() => store.setVerbosity(5));
});

test('dm guide: mentions the scene, combat and resource tools, and they are registered', async () => {
  const { store, db } = newTable();
  const tools = await (await mcpClient(store, db)).listTools();
  for (const tool of ['add_to_scene', 'update_presence', 'remove_from_scene', 'start_combat', 'next_turn', 'add_to_combat', 'end_combat', 'use_resource', 'rest', 'hero_fell', 'death save']) {
    assert.ok(DM_GUIDE.includes(tool), `guide mentions ${tool}`);
    if (/^[a-z_]+$/.test(tool) && tool !== 'hero_fell') assert.ok(tools.includes(tool), `${tool} registered`);
  }
});

test('mcp: the DM hears when the table switches adventures while waiting', async () => {
  const { store, db } = newTable();
  const a = store.createGame('Cave World');
  const mcp = await mcpClient(store, db);
  await mcp.call('get_game_state');
  const b = store.createGame('Sky Isles');
  store.setActiveGame(a.id);
  const started = Date.now();
  const waiting = mcp.call('wait_for_players', { timeout_seconds: 5 });
  setTimeout(() => store.setActiveGame(b.id), 20);
  const { text } = await waiting;
  assert.ok(Date.now() - started < 2000, 'the switch ends the wait right away');
  assert.match(text, /ADVENTURE CHANGED/);
  assert.match(text, /Sky Isles/);
  assert.match(text, /get_game_state/);
});

test('mcp: a switch between waits is reported once, on the next wait', async () => {
  const { store, db } = newTable();
  store.createGame('Cave World');
  const mcp = await mcpClient(store, db);
  await mcp.call('get_game_state');
  const b = store.createGame('Sky Isles');
  store.append(b.id, { type: 'message', from: 'player', kind: 'ooc', text: 'hi' });
  const first = await mcp.call('wait_for_players', { timeout_seconds: 5 });
  assert.match(first.text, /ADVENTURE CHANGED/);
  assert.match(first.text, /Sky Isles/);
  const second = await mcp.call('wait_for_players', { timeout_seconds: 5 });
  assert.doesNotMatch(second.text, /ADVENTURE CHANGED/);
  assert.match(second.text, /hi/);
});

test('mcp: no switch notice when the adventure stays the same', async () => {
  const { store, db } = newTable();
  const a = store.createGame('Cave World');
  const mcp = await mcpClient(store, db);
  await mcp.call('get_game_state');
  store.append(a.id, { type: 'message', from: 'player', kind: 'ooc', text: 'hello' });
  const { text } = await mcp.call('wait_for_players', { timeout_seconds: 5 });
  assert.doesNotMatch(text, /ADVENTURE CHANGED/);
});
