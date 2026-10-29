// The DM's voice, made on this machine with macOS `say`. Browsers can't reach the Enhanced and
// Premium system voices and sometimes fall back to an English voice for Finnish text, so the
// server speaks and the page plays the audio. Without `say` there are no voices here and the
// page uses the browser's own.

import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export interface Voice {
  /** As `say -v` knows it, e.g. "Satu (Enhanced)". */
  name: string;
  /** The page's language code: 'fi', 'en'. */
  lang: string;
  /** "GB", "US", "FI", "IN". */
  region: string;
  quality: 'premium' | 'enhanced' | 'standard';
}

// Novelty voices and the old Eloquence ones sound like robots; nobody wants them reading a story.
const ROBOTIC = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Wobble|Fred|Good News|Jester|Junior|Kathy|Organ|Superstar|Ralph|Trinoids|Whisper|Zarvox|Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley)\b/;
const RANK = { premium: 0, enhanced: 1, standard: 2 };
// Among voices as good, the accents a table here most likely expects come first.
const HOME = ['FI', 'GB', 'US'];
const home = (v: Voice) => (HOME.includes(v.region) ? 0 : 1);

/** Parses `say -v '?'`: "Satu (Enhanced)     fi_FI    # Hei! Nimeni on Satu." */
export function parseVoices(listing: string): Voice[] {
  const voices: Voice[] = [];
  for (const line of listing.split('\n')) {
    const m = line.match(/^(.+?)\s+([a-z]{2,3})_([A-Za-z0-9]+)\s+#/);
    if (!m || ROBOTIC.test(m[1])) continue;
    const quality = /\(Premium\)/i.test(m[1]) ? 'premium' : /\(Enhanced\)/i.test(m[1]) ? 'enhanced' : 'standard';
    voices.push({ name: m[1].trim(), lang: m[2], region: m[3], quality });
  }
  return voices.sort((a, b) => RANK[a.quality] - RANK[b.quality] || home(a) - home(b));
}

let listed: Promise<Voice[]> | null = null;

/** The voices installed on this machine, best first; empty where there is no `say`. */
export function voices(): Promise<Voice[]> {
  listed ??= new Promise((resolve) => {
    if (process.platform !== 'darwin') return resolve([]);
    execFile('say', ['-v', '?'], (err, out) => resolve(err ? [] : parseVoices(out)));
  });
  return listed;
}

/** Look again next time, e.g. when the page lists voices: one may have been downloaded meanwhile. */
export function forgetVoices(): void {
  listed = null;
}

/**
 * The text spoken by `voice` as an AAC file, made once and kept in `dir`.
 * The voice must be one `voices()` lists; the text goes in on stdin so it is never read as options.
 */
export async function speech(dir: string, voice: string, text: string): Promise<string> {
  if (!(await voices()).some((v) => v.name === voice)) throw new Error(`No voice "${voice}" on this machine`);
  const spoken = text.replace(/[*_#`>]/g, '').trim();
  if (!spoken) throw new Error('Nothing to say');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${createHash('sha256').update(`${voice}\n${spoken}`).digest('hex').slice(0, 32)}.m4a`);
  if (existsSync(file)) return file;
  const part = `${file}.${process.pid}.part.m4a`;
  await new Promise<void>((resolve, reject) => {
    const say = spawn('say', ['-v', voice, '-f', '-', '-o', part, '--file-format=m4af', '--data-format=aac']);
    let err = '';
    say.stderr.on('data', (d) => (err += d));
    say.on('error', reject);
    say.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`say failed: ${err.trim() || code}`))));
    say.stdin.end(spoken);
  });
  renameSync(part, file);
  return file;
}
