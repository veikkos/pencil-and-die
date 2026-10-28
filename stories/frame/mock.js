// Stands in for the server inside a story frame: the page's API answers from the saved fixtures,
// writes go nowhere and the live stream stays silent. The query string says what to show:
//   game=<fixture> lang=en|fi level=beginner|casual|intermediate verbosity=1..4 fallen=knockout|death
//   dm=offline|listening|thinking voice=on
//   steps=<JSON list of ["click", selector, text?] / ["type", selector, text] / ["scroll", selector, top]>, run once the page is up.
//   A click with text picks the first match containing it, e.g. ["click", ".pc.hero", "Elowen"].

const q = new URLSearchParams(location.search);
const data = await (await fetch('../fixtures/data.json')).json();
const game = data.games[q.get('game')] ?? null;

const config = {
  ...data.config,
  language: q.get('lang') ?? 'en',
  complexity: q.get('level') ?? 'beginner',
  verbosity: Number(q.get('verbosity') ?? 3),
  fallenHeroes: q.get('fallen') ?? 'knockout',
  activeGameId: game?.id ?? null,
};
let prefs = { voice: q.get('voice') === 'on' };
const dmStatus = q.get('dm') ?? game?.state.dmStatus;

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function answer(method, path) {
  if (path === '/api/config') return config;
  if (path === '/api/rules') return data.rules;
  if (path === '/api/prefs') return prefs;
  const m = /^\/api\/games\/([^/]+)\/(state|history)$/.exec(path);
  if (m && game && m[1] === game.id) return m[2] === 'state' ? { ...game.state, dmStatus, language: config.language, complexity: config.complexity } : game.history;
  if (method === 'POST') return { ok: true };
  return null;
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
  const method = (init.method ?? 'GET').toUpperCase();
  const body = init.body ? JSON.parse(init.body) : undefined;
  if (method === 'POST') console.info('[story] POST', url.pathname, body);
  if (url.pathname === '/api/prefs' && method === 'POST') prefs = { ...prefs, ...body };
  const out = answer(method, url.pathname);
  return out === null ? json({ error: `No fixture for ${method} ${url.pathname}` }, 404) : json(out);
};

window.EventSource = class { close() {} };

const until = async (selector, text) => {
  for (let i = 0; i < 100; i++) {
    const el = text === undefined ? document.querySelector(selector)
      : [...document.querySelectorAll(selector)].find((x) => x.textContent.includes(text));
    if (el) return el;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`Story step: nothing matches ${selector}`);
};

export async function runSteps() {
  for (const [action, selector, text] of JSON.parse(q.get('steps') ?? '[]')) {
    const el = await until(selector, action === 'click' ? text : undefined);
    if (action === 'click') el.click();
    if (action === 'type') { el.value = text; el.dispatchEvent(new Event('input')); }
    if (action === 'scroll') { el.scrollTop = Number(text); el.dispatchEvent(new Event('scroll')); }
  }
}
