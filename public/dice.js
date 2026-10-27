// Recognisable outlines of the physical dice, so players grab the right one.

const SHAPES = {
  4: { points: '50,8 94,86 6,86', inner: 'M50,8 L50,62 M50,62 L94,86 M50,62 L6,86' },
  6: { points: '14,14 86,14 86,86 14,86', inner: '' },
  8: { points: '50,4 94,50 50,96 6,50', inner: 'M6,50 L94,50' },
  10: { points: '50,4 94,42 50,96 6,42', inner: 'M6,42 L50,58 L94,42 M50,58 L50,96' },
  12: { points: '50,4 93,35 77,88 23,88 7,35', inner: 'M50,22 L72,38 L64,66 L36,66 L28,38 Z' },
  20: { points: '50,3 92,27 92,73 50,97 8,73 8,27', inner: 'M50,3 L30,62 L70,62 Z M30,62 L50,97 L70,62 M8,27 L30,62 M92,27 L70,62 M8,73 L30,62 M92,73 L70,62' },
  100: { points: '50,4 94,42 50,96 6,42', inner: 'M6,42 L50,58 L94,42 M50,58 L50,96' },
};

// Colours come from CSS (--die-N) so they adapt to light/dark mode.
const COLOR_VAR = { 4: '--die-4', 6: '--die-6', 8: '--die-8', 10: '--die-10', 12: '--die-12', 20: '--die-20', 100: '--die-10' };

export function dieSvg(sides, size = 84) {
  const s = SHAPES[sides] ?? SHAPES[6];
  const c = 'currentColor';
  const label = sides === 100 ? '%' : sides;
  return `<svg class="die-svg" style="color: var(${COLOR_VAR[sides] ?? '--ink'})" width="${size}" height="${size}" viewBox="0 0 100 100" aria-label="d${sides}">
    <polygon points="${s.points}" fill="${c}" fill-opacity="0.14" stroke="${c}" stroke-width="4" stroke-linejoin="round"/>
    ${s.inner ? `<path d="${s.inner}" fill="none" stroke="${c}" stroke-width="1.6" stroke-opacity="0.55"/>` : ''}
    <text x="50" y="${sides === 4 ? 74 : 58}" text-anchor="middle" font-size="${sides === 100 ? 22 : 20}" font-weight="700" fill="${c}" font-family="system-ui, sans-serif">d${label}</text>
  </svg>`;
}
