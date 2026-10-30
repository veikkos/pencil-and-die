// Where a DM drifts from the guide, read off a game's event log. The same checks nudge the DM
// live (narrate's result) and, run as a script, report on a whole saved game:
//   npm run dm-report -- <game id> [db path]

import { fileURLToPath } from 'node:url';
import type { StoredEvent } from './state.ts';
import type { Verbosity } from './store.ts';

/** The most sentences a beat should have at each verbosity (the guide's upper bounds). */
const MOST_SENTENCES: Record<Verbosity, number> = { 1: 2, 2: 3, 3: 5, 4: 8 };

/** A new sentence starts with a capital (or an opening quote) after . ! ? or …, so "Back!" he roars is one. */
export const sentences = (text: string) => text.split(/(?<=[.!?…]["”»)]*)\s+(?=[\p{Lu}"“«(])/u).filter((x) => /\p{L}/u.test(x)).length;

/** A word to look for in the story: the start of a name, so inflected forms ("kovakuoriaista") match too. */
const stem = (name: string) => name.trim().toLowerCase().split(/\s+/).at(-1)!.slice(0, 6);

/** Said to the DM after a narration that runs long. One sentence of slack, so it nudges rather than nags. */
export function lengthNudge(text: string, verbosity: Verbosity): string {
  const n = sentences(text);
  const most = MOST_SENTENCES[verbosity];
  return n > most + 1 ? ` That was ${n} sentences; at verbosity ${verbosity}/4 a beat is at most ${most}. Keep the next ones shorter.` : '';
}

/** Narration that tells a player to roll: "Heitä hyökkäys", "Heittäkää aloitusjärjestys", "Roll for initiative". */
export const asksForRoll = (text: string) =>
  /(^|[^\p{L}])(heit(ä|äkää|täkää)|roll)(?![\p{L}])/iu.test(text);

/** Said to the DM when a narration asks for a roll that nobody has been sent: the page has no dice to show.
 *  A roll counts while it is pending, or when it was asked for since the DM last spoke (a quick player has rolled it already). */
export function rollNudge(text: string, rollsInPlay: number): string {
  return asksForRoll(text) && rollsInPlay === 0
    ? ' That asks for a roll, but none is pending, so the page shows no dice. If a player should roll, call request_roll now.'
    : '';
}

export interface Finding {
  check: 'long' | 'unsketched' | 'unlisted' | 'manualDamage' | 'notedNumbers' | 'unrequestedRoll';
  seq: number;
  text: string;
}

/** Everything the checks find in a game, in story order. */
export function review(events: StoredEvent[], verbosity: Verbosity): Finding[] {
  const out: Finding[] = [];
  const recentNarration: { seq: number; text: string }[] = [];
  let sceneWithoutSketch: number | null = null;
  const pending = new Set<string>();
  let requestedSinceDm = 0;
  // A narration that asked for a roll with none pending; fine if the request follows before the players answer.
  let askedWithoutRoll: number | null = null;
  for (const { seq, event: e } of events) {
    switch (e.type) {
      case 'roll_requested':
        pending.add(e.roll.rollId);
        requestedSinceDm++;
        askedWithoutRoll = null;
        break;
      case 'roll_resolved':
      case 'roll_cancelled':
        pending.delete(e.rollId);
        break;
      case 'message':
        if (e.from === 'player' && askedWithoutRoll !== null) {
          out.push({ check: 'unrequestedRoll', seq: askedWithoutRoll, text: 'asked for a roll in the story but never called request_roll' });
          askedWithoutRoll = null;
        }
        if (e.from !== 'dm' || e.kind === 'ooc') break;
        if (rollNudge(e.text, pending.size + requestedSinceDm)) askedWithoutRoll = seq;
        requestedSinceDm = 0;
        if (lengthNudge(e.text, verbosity)) out.push({ check: 'long', seq, text: `${sentences(e.text)} sentences at verbosity ${verbosity}` });
        if (sceneWithoutSketch !== null) {
          out.push({ check: 'unsketched', seq, text: `narrated a new scene (seq ${sceneWithoutSketch}) before sketching it` });
          sceneWithoutSketch = null;
        }
        recentNarration.push({ seq, text: e.text.toLowerCase() });
        if (recentNarration.length > 3) recentNarration.shift();
        break;
      case 'scene_set':
        sceneWithoutSketch = seq;
        recentNarration.length = 0;
        break;
      case 'sketch':
        sceneWithoutSketch = null;
        break;
      case 'presence_added': {
        const names = [...new Set(e.presences.map((p) => p.name))];
        const early = names.filter((n) => recentNarration.some((r) => r.text.includes(stem(n))));
        if (early.length) out.push({ check: 'unlisted', seq, text: `${early.join(', ')} narrated before being added to the scene` });
        break;
      }
      case 'presence_updated':
        if ((e.patch.hpDelta ?? 0) < 0) out.push({ check: 'manualDamage', seq, text: `${e.presenceId} damaged by hand (${e.patch.hpDelta}); a targeted roll would apply it` });
        break;
      case 'character_updated':
        if ((e.patch.hpDelta ?? 0) < 0) out.push({ check: 'manualDamage', seq, text: `${e.characterId} damaged by hand (${e.patch.hpDelta})${e.reason ? `, ${e.reason}` : ''}; dm_roll with target and damage would apply it` });
        break;
      case 'dm_note':
        if (/\b(HP|AC|OP|PL)\s*\d|\d+\s*(HP|OP)\b|\bspell slots?\b/i.test(e.text)) {
          out.push({ check: 'notedNumbers', seq, text: 'a DM note keeps HP, AC or slots, which the roster and counters already track' });
        }
        break;
    }
  }
  return out;
}

const HEADINGS: Record<Finding['check'], string> = {
  long: 'Narration longer than the verbosity setting',
  unsketched: 'New scene narrated before it was sketched',
  unlisted: 'Creatures in the story before they were in the scene',
  manualDamage: 'Damage applied by hand',
  notedNumbers: 'Numbers kept in notes',
  unrequestedRoll: 'Rolls asked for without request_roll',
};

export function reportText(title: string, findings: Finding[]): string {
  if (!findings.length) return `${title}: nothing to report.`;
  const groups = Object.entries(HEADINGS).map(([check, heading]) => {
    const hits = findings.filter((f) => f.check === check);
    return hits.length ? `${heading} (${hits.length})\n${hits.map((f) => `  [${f.seq}] ${f.text}`).join('\n')}` : '';
  });
  return [`${title}: ${findings.length} findings`, ...groups.filter(Boolean)].join('\n\n');
}

if (import.meta.main) {
  const [gameId, dbPath = fileURLToPath(new URL('../data/game.db', import.meta.url))] = process.argv.slice(2);
  if (!gameId) {
    console.error('Usage: npm run dm-report -- <game id> [db path]');
    process.exit(1);
  }
  const { openDb } = await import('./db.ts');
  const { GameStore } = await import('./store.ts');
  const store = new GameStore(openDb(dbPath));
  store.requireGame(gameId);
  const verbosity = store.verbosity(gameId);
  // Settings aren't events, so lengths are judged against the verbosity the adventure has now.
  console.log(reportText(`${store.state(gameId).title} (${gameId}, judged at verbosity ${verbosity})`, review(store.liveEvents(gameId), verbosity)));
}
