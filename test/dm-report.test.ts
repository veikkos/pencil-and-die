import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lengthNudge, review, sentences } from '../src/dm-report.ts';
import type { GameEvent } from '../src/state.ts';
import { mcpClient, newTable } from './helpers.ts';

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
