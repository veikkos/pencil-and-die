import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseVoices } from '../src/tts.ts';

test('voices: the best first, home accents before others, robotic ones left out', () => {
  const listing = [
    'Aman                en_IN    # Hello! My name is Aman.',
    'Bells               en_US    # Hello! My name is Bells.',
    'Daniel              en_GB    # Hello! My name is Daniel.',
    'Eddy (Finnish (Finland)) fi_FI    # Hei! Nimeni on Eddy.',
    'Satu                fi_FI    # Hei! Nimeni on Satu.',
    'Satu (Enhanced)     fi_FI    # Hei! Nimeni on Satu.',
    'Ava (Premium)       en_US    # Hello! My name is Ava.',
  ].join('\n');
  assert.deepEqual(parseVoices(listing).map((v) => `${v.name}/${v.lang}/${v.quality}`), [
    'Ava (Premium)/en/premium', 'Satu (Enhanced)/fi/enhanced', 'Daniel/en/standard', 'Satu/fi/standard', 'Aman/en/standard',
  ]);
});
