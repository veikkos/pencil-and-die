import { getSetting, setSetting, type Db } from './db.ts';

export const SKETCH_WIDTH = 800;
export const SKETCH_HEIGHT = 500;

// Stored in the DB so every DM session (and future Claude instances) draws in the
// same hand. Editable through the MCP `set_sketch_style` tool.
export const DEFAULT_SKETCH_STYLE = `# Sketch style guide: graphite on paper

The canvas is an SVG with viewBox "0 0 ${SKETCH_WIDTH} ${SKETCH_HEIGHT}". You send only the inner
elements (path, line, polyline, circle, ellipse, rect, polygon, g, text). The table renders
them on cream paper and adds a pencil filter (wobbly lines, grain), so do NOT add your own
filters, gradients, images, or background fills.

## Strokes
- Colour: graphite only. Use stroke="#2b2b2b" for main lines, "#555" for secondary lines and
  "#8a8a8a" for faint construction or distance lines. No colour except, sparingly, one accent
  (#8b2e2e, dried blood or wax seal) for something the players must notice.
- Width: 2.5–3.5 for silhouettes and nearby objects, 1.5 for detail, 0.8–1 for hatching and
  far-away things. Distant objects get thinner, lighter lines (atmospheric perspective).
- Always stroke-linecap="round" stroke-linejoin="round" and fill="none".
- Prefer hand-drawn paths (cubic/quadratic curves with slight irregularity) over perfect
  rects and circles. Let lines overshoot corners a little, as a quick sketch would.
- Draw important outlines twice with a slightly offset second path, like a sketcher
  going over a line again.

## Shading
- Shade with hatching: groups of short parallel strokes at ~45°, spaced 4–7 px. Cross-hatch
  (a second set at -45°) for deep shadow. Never use solid fills for shadow.
- A light source from the upper left keeps shadows consistent: shade right and lower sides.
- Leave plenty of white paper. Suggest rather than finish: fade out the edges of the scene.

## Composition
- One clear focal point, usually at a rule-of-thirds intersection.
- A horizon or ground line anchors outdoor scenes; a few floor/wall lines anchor rooms.
- Scenes: 40–150 elements is plenty. Maps: top-down, walls as double lines, doors as gaps
  with a short tick, a small compass rose in a corner, squares ~40 px = 5 ft if useful.
- Labels: few and short, in <text font-family="'Caveat', 'Segoe Print', cursive" font-size="20"
  fill="#2b2b2b">. Use them for maps and for things the characters have named.

## Subjects
- Creatures: gesture first (one flowing spine curve), then mass, then a few defining
  features (horns, teeth, eyes). Silhouettes read better than detail.
- Never draw the player characters' faces in detail: players imagine their own heroes.
- Show only what the characters can perceive. Hidden things stay out of the sketch.
`;

export function getSketchStyle(db: Db): string {
  return getSetting(db, 'sketch_style') ?? DEFAULT_SKETCH_STYLE;
}

export function setSketchStyle(db: Db, style: string): void {
  setSetting(db, 'sketch_style', style);
}

const ALLOWED_TAGS = new Set(['g', 'path', 'line', 'polyline', 'polygon', 'circle', 'ellipse', 'rect', 'text', 'tspan', 'title']);

/**
 * Keeps sketches to plain drawing primitives. The page renders them as markup, so
 * scripts, event handlers, links and foreign content are rejected outright.
 */
export function sanitizeSketch(svg: string): string {
  const body = svg.trim().replace(/^<svg[^>]*>/i, '').replace(/<\/svg>\s*$/i, '');
  if (body.length > 400_000) throw new Error('Sketch is too large; keep it under ~400 KB of SVG.');
  for (const m of body.matchAll(/<\/?\s*([a-zA-Z][\w:-]*)/g)) {
    if (!ALLOWED_TAGS.has(m[1].toLowerCase())) throw new Error(`<${m[1]}> is not allowed in sketches. Allowed: ${[...ALLOWED_TAGS].join(', ')}.`);
  }
  if (/\son\w+\s*=/i.test(body)) throw new Error('Event handler attributes are not allowed in sketches.');
  if (/(href|javascript:|url\s*\(|<!|<\?)/i.test(body)) throw new Error('Links, url() references and declarations are not allowed in sketches.');
  return body;
}
