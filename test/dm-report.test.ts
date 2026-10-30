import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asksForRoll, lengthNudge, review, sentences } from '../src/dm-report.ts';
import type { GameEvent } from '../src/state.ts';
import { mcpClient, mira, newTable } from './helpers.ts';

const log = (...events: GameEvent[]) => events.map((event, i) => ({ seq: i + 1, at: '', event }));
const dm = (text: string): GameEvent => ({ type: 'message', from: 'dm', kind: 'narration', text });

test('sentences: counts sentences, not shouts or quotes inside them', () => {
  assert.equal(sentences('The bell rings. Again! Who rang it?'), 3);
  assert.equal(sentences('"Back!" he roars. They flee.'), 2);
  assert.equal(sentences('One… Two.'), 2);
  assert.equal(sentences('Wait… what?'), 1);
  assert.equal(sentences(''), 0);
});

test('lengthNudge: one sentence of slack over the verbosity bound', () => {
  assert.equal(lengthNudge('A. B. C. D.', 2), '');
  assert.match(lengthNudge('A. B. C. D. E.', 2), /5 sentences; at verbosity 2\/4 a beat is at most 3/);
});

test('review: finds the drift the first playtest showed', () => {
  const findings = review(log(
    { type: 'scene_set', title: 'Clock room', description: '' },
    dm('Three beetles turn towards you.'),
    { type: 'presence_added', presences: [{ id: 'beetle-1', name: 'Beetle', groupId: 'beetle-1', side: 'enemy', description: '', conditions: [], notes: '', defeated: false }] },
    { type: 'character_updated', characterId: 'mira', patch: { hpDelta: -4 }, reason: 'bite' },
    { type: 'presence_updated', presenceId: 'beetle-1', patch: { hpDelta: -4 } },
    { type: 'dm_note', text: 'Beetles HP 4, AC 14' },
    dm('One. Two. Three. Four. Five. Six.'),
  ), 2);
  assert.deepEqual(findings.map((f) => [f.check, f.seq]), [
    ['unsketched', 2], ['unlisted', 3], ['manualDamage', 4], ['manualDamage', 5], ['notedNumbers', 6], ['long', 7],
  ]);
  assert.deepEqual(review(log({ type: 'scene_set', title: 'x', description: '' }, { type: 'sketch', caption: 'x', svg: '' }, dm('Fine.')), 2), []);
});

test('narrate: nudges the DM when a beat runs long', async () => {
  const { store, db } = newTable();
  const g = store.createGame('T');
  store.setVerbosity(1, g.id);
  const c = await mcpClient(store, db);
  assert.match((await c.call('narrate', { text: 'One. Two. Three. Four.' })).text, /4 sentences/);
  assert.doesNotMatch((await c.call('narrate', { text: 'One. Two.' })).text, /sentences/);
  assert.doesNotMatch((await c.call('narrate', { text: 'One. Two. Three. Four.', kind: 'ooc' })).text, /sentences/);
});

const player = (text: string): GameEvent => ({ type: 'message', from: 'player', characterId: 'vesoi', kind: 'action', text });
const asked = (rollId: string): GameEvent => ({ type: 'roll_requested', roll: { rollId, characterId: 'vesoi', label: 'x', dice: '1d20', modifier: 0, advantage: 'none', hideDc: true } });

test('asksForRoll: a call to roll, not a throw in the story', () => {
  for (const t of ['Heitä hyökkäys.', 'Heittäkää aloitusjärjestys, kapakkatappelu alkaa.', 'Heitä vielä vahinko, Vesoi.', 'Roll for initiative!']) assert.ok(asksForRoll(t), t);
  for (const t of ['Jussi heittää tuopin.', 'Kivi lentää.', 'The barrel rolls away.']) assert.ok(!asksForRoll(t), t);
});

test('review: a roll asked for in the story but never requested (Luolamaailma, seq 222)', () => {
  const findings = review(log(
    player('nappaan jakkaran'),
    dm('Vesoi kahmaisee jakkaran. Heitä hyökkäys.'),
    player('20d:llä heitetty 10'),
  ), 4);
  assert.deepEqual(findings.map((f) => [f.check, f.seq]), [['unrequestedRoll', 2]]);
  // Narrating first and requesting right after is fine, as is asking while a roll is pending.
  assert.deepEqual(review(log(dm('Heittäkää kumpikin.'), asked('a'), player('17')), 4), []);
  assert.deepEqual(review(log(asked('a'), dm('Heitä hyökkäys.'), player('ok')), 4), []);
  // A quick player rolled what the engine asked for before the DM's narration told them to (Tuhkatorni, seq 50).
  assert.deepEqual(review(log(asked('a'), { type: 'roll_resolved', rollId: 'a', faces: [5], total: 8 }, dm('Heitä noppaa.'), player('ok')), 4), []);
});

test('narrate: nudges the DM when it asks for a roll nobody was sent', async () => {
  const { store, db } = newTable();
  const g = store.createGame('T');
  store.append(g.id, { type: 'character_created', character: mira() });
  const c = await mcpClient(store, db);
  assert.match((await c.call('narrate', { text: 'Heitä hyökkäys.' })).text, /none is pending/);
  assert.doesNotMatch((await c.call('narrate', { text: 'Jakkara osuu.' })).text, /none is pending/);
  // Already rolled since the DM last spoke: nothing to nudge about.
  store.append(g.id, { type: 'roll_requested', roll: { rollId: 'r1', characterId: 'mira', label: 'Concentration', dice: '1d20', modifier: 3, advantage: 'none', hideDc: true } });
  store.append(g.id, { type: 'roll_resolved', rollId: 'r1', faces: [5], total: 8, success: false });
  assert.doesNotMatch((await c.call('narrate', { text: 'Heitä noppaa.' })).text, /none is pending/);
  assert.match((await c.call('narrate', { text: 'Heitä uudestaan.' })).text, /none is pending/);
});
