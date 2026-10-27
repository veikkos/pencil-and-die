import { STRINGS, FI_RULES, sign } from './i18n.js';
import { dieSvg } from './dice.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const app = document.getElementById('app');
let cfg = { language: 'en', complexity: 'beginner', verbosity: 3, activeGameId: null, games: [] };
let prefs = { voice: false, voiceName: { en: null, fi: null } };
let rules = null;
let view = 'lobby';
let gameId = null;
let live = null;          // current game state
let shown = null;         // what is on screen: live, or a past state while scrubbing
let viewSeq = null;       // null = now, else the seq being previewed
let history = [];
let speaker = null;
let kind = 'action';
let sketchIndex = null;   // null = follow latest
let lastSketchSeq = 0;
let spokenSeq = Infinity; // DM lines after this get read aloud
const rollDrafts = {};

const t = () => STRINGS[cfg.language];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mod = (score) => Math.floor((score - 10) / 2);
const level = () => cfg.complexity;
const isBeginner = () => cfg.complexity === 'beginner';
const isExpert = () => cfg.complexity === 'intermediate';
/** Engine rolls (initiative, death saves) and conditions arrive in English; name them in the page's language and level. */
const rollLabel = (purpose, fallback) => t().rollLabels[purpose]?.[level()] ?? fallback;
const condName = (c) => t().conditionNames[c]?.[level()] ?? c;
const condList = (cs) => cs.map((c) => esc(condName(c))).join(', ');

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  // A non-JSON reply means the page is newer than the running server.
  if (!data) throw new Error(`${t().serverOutdated} (${res.status} ${path})`);
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

function fail(err) { alert(err.message ?? err); }

// Localised names for things stored by id.
const raceName = (c) => (cfg.language === 'fi' ? FI_RULES.races[c.raceId]?.[0] : null) ?? c.race;
const className = (c) => (cfg.language === 'fi' ? FI_RULES.classes[c.classId]?.[0] : null) ?? c.className;
const skillName = (s) => (cfg.language === 'fi' ? FI_RULES.skills[s] : null) ?? s;
const ruleText = (group, item) => (cfg.language === 'fi' && FI_RULES[group][item.id]) ? FI_RULES[group][item.id] : [item.name, item.blurb];

// ---------------------------------------------------------------------------
// Boot & live updates
// ---------------------------------------------------------------------------

async function boot() {
  [cfg, prefs, rules] = await Promise.all([api('/api/config'), api('/api/prefs'), api('/api/rules')]);
  prefs = { voice: false, voiceName: { en: null, fi: null }, ...prefs };
  document.documentElement.lang = cfg.language;
  if (cfg.activeGameId) await openGame(cfg.activeGameId, false);
  else render();

  const stream = new EventSource('/api/stream');
  stream.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === 'change' && ev.gameId === gameId) scheduleRefresh();
    if (ev.type === 'language') { cfg.language = ev.language; document.documentElement.lang = ev.language; render(); }
    if (ev.type === 'complexity') { cfg.complexity = ev.complexity; rerenderAll(); }
    if (ev.type === 'verbosity') { cfg.verbosity = ev.verbosity; rerenderAll(); }
    if (ev.type === 'fallenHeroes') { cfg.fallenHeroes = ev.fallenHeroes; rerenderAll(); }
  };
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 60);
}

async function refresh() {
  if (!gameId) return;
  const [state, hist] = await Promise.all([api(`/api/games/${gameId}/state`), api(`/api/games/${gameId}/history`)]);
  const firstLoad = !live;
  live = state;
  history = hist;
  if (viewSeq !== null && !history.some((h) => h.seq === viewSeq)) viewSeq = null;
  if (viewSeq === null) shown = live;
  if (firstLoad) spokenSeq = live.seq;
  else speakNew();

  const wanted = live.started ? 'table' : 'setup';
  if (view !== wanted && (view === 'table' || view === 'setup')) view = wanted;
  render();
}

async function openGame(id, activate = true) {
  if (activate) await api(`/api/games/${id}/open`, {});
  gameId = id;
  live = null; shown = null; viewSeq = null; sketchIndex = null; lastSketchSeq = 0;
  view = 'setup';
  await refresh();
}

async function setLanguage(lang) {
  if (lang === cfg.language) return;
  await api('/api/language', { language: lang });
  cfg.language = lang;
  document.documentElement.lang = lang;
  render();
}

async function setComplexity(level) {
  if (level === cfg.complexity) return;
  await api('/api/complexity', { complexity: level });
  cfg.complexity = level;
  rerenderAll();
}

async function setVerbosity(level) {
  if (level === cfg.verbosity) return;
  await api('/api/verbosity', { verbosity: level });
  cfg.verbosity = level;
  rerenderAll();
}

async function setFallenHeroes(mode) {
  if (mode === cfg.fallenHeroes) return;
  await api('/api/fallen-heroes', { fallenHeroes: mode });
  cfg.fallenHeroes = mode;
  rerenderAll();
}

/** Forces every region to rebuild (language/complexity changed). */
function rerenderAll() {
  app.dataset.lang = '';
  render();
}

function render() {
  if (view === 'lobby' || !gameId || !live) renderLobby();
  else if (view === 'setup') renderSetup();
  else renderTable();
  drawSettings();
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function settingsButton() {
  return `<button class="ghost gear" data-settings title="${esc(t().settings.open)}" aria-label="${esc(t().settings.open)}">⚙</button>`;
}

function bindCommon(root) {
  root.querySelectorAll('[data-settings]').forEach((b) => b.onclick = openSettings);
  root.querySelectorAll('[data-go-lobby]').forEach((b) => b.onclick = async () => { view = 'lobby'; cfg = await api('/api/config'); render(); });
}

// ---- Settings overlay ---------------------------------------------------------

/**
 * Everything the settings overlay shows, group by group. A row picks one of its choices,
 * as buttons or, with `select` or more than four choices, a dropdown. Adding a setting means adding a row here.
 */
const SETTING_GROUPS = [
  { id: 'table', rows: [
    { id: 'language', label: (s) => s.settings.language, hint: (s) => s.settings.languageHint,
      choices: () => [['en', 'English'], ['fi', 'Suomi']], value: () => cfg.language, pick: setLanguage },
  ] },
  { id: 'story', rows: [
    { id: 'verbosity', label: (s) => s.verbosity, hint: (s) => s.verbosityHints[cfg.verbosity],
      choices: (s) => [1, 2, 3, 4].map((v) => [String(v), s.verbosityLevels[v]]), value: () => String(cfg.verbosity), pick: (v) => setVerbosity(Number(v)) },
  ] },
  { id: 'rules', rows: [
    { id: 'complexity', label: (s) => s.complexity, hint: (s) => s.levelHints[level()],
      choices: (s) => Object.entries(s.levels), value: level, pick: setComplexity },
    { id: 'fallen', label: (s) => s.fallen.label, hint: (s) => s.fallen.hints[cfg.fallenHeroes],
      choices: (s) => [['knockout', s.fallen.knockout], ['death', s.fallen.death]], value: () => cfg.fallenHeroes, pick: setFallenHeroes },
  ] },
  { id: 'voice', rows: [
    { id: 'voice', label: (s) => s.settings.readAloud, hint: (s) => s.settings.readAloudHint,
      choices: (s) => [['off', s.settings.off], ['on', s.settings.on]], value: () => (prefs.voice ? 'on' : 'off'), pick: (v) => savePrefs({ voice: v === 'on' }) },
    { id: 'voice-name', select: true, label: (s) => s.settings.voiceName, hint: (s) => (voicesFor(cfg.language).length ? '' : s.noVoice),
      choices: () => voiceChoices(), value: () => pickVoice()?.name, pick: (v) => savePrefs({ voiceName: { ...prefs.voiceName, [cfg.language]: v } }),
      extra: (s) => (voicesFor(cfg.language).length ? `<button class="ghost" data-voice-test title="${esc(s.testVoice)}">▶︎</button>` : '') },
  ] },
];

let settingsModal = null;

function openSettings() {
  if (settingsModal) return;
  settingsModal = document.createElement('div');
  settingsModal.className = 'modal settings';
  settingsModal.onclick = (e) => { if (e.target === settingsModal) closeSettings(); };
  document.addEventListener('keydown', settingsKey);
  document.body.appendChild(settingsModal);
  drawSettings();
}

function closeSettings() {
  settingsModal?.remove();
  settingsModal = null;
  document.removeEventListener('keydown', settingsKey);
}

function settingsKey(e) {
  if (e.key === 'Escape') closeSettings();
}

function settingControl(row, s) {
  const choices = row.choices(s);
  const current = row.value();
  if (!choices.length) return '';
  if (row.select || choices.length > 4) {
    return `<select class="input" data-row="${row.id}" aria-label="${esc(row.label(s))}">${choices.map(([v, label]) =>
      `<option value="${esc(v)}" ${v === current ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
  }
  return `<span class="seg" role="group" aria-label="${esc(row.label(s))}">${choices.map(([v, label]) =>
    `<button data-row="${row.id}" data-value="${esc(v)}" class="${v === current ? 'on' : ''}" aria-pressed="${v === current}">${esc(label)}</button>`).join('')}</span>`;
}

/** (Re)draws the open overlay; called on open and after every render so it follows changes from other tabs. */
function drawSettings() {
  if (!settingsModal) return;
  const s = t();
  const rows = SETTING_GROUPS.flatMap((g) => g.rows);
  settingsModal.innerHTML = `<div class="card" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <div class="settings-head"><h2 id="settings-title">${esc(s.settings.title)}</h2>
      <button class="ghost" data-close title="${esc(s.settings.close)}" aria-label="${esc(s.settings.close)}">✕</button></div>
    ${SETTING_GROUPS.map((g) => `<section class="settings-group">
      <h3>${esc(s.settings.groups[g.id])}</h3>
      ${g.rows.filter((row) => row.id !== 'voice-name' || prefs.voice).map((row) => {
        const hint = row.hint?.(s);
        return `<div class="setting"><div><b>${esc(row.label(s))}</b>${hint ? `<small>${esc(hint)}</small>` : ''}</div>
          <div class="setting-control">${settingControl(row, s)}${row.extra?.(s) ?? ''}</div></div>`;
      }).join('')}
    </section>`).join('')}
  </div>`;
  settingsModal.querySelector('[data-close]').onclick = closeSettings;
  settingsModal.querySelectorAll('button[data-row]').forEach((b) => b.onclick = () =>
    rows.find((r) => r.id === b.dataset.row).pick(b.dataset.value)?.catch?.(fail));
  settingsModal.querySelectorAll('select[data-row]').forEach((sel) => sel.onchange = () =>
    rows.find((r) => r.id === sel.dataset.row).pick(sel.value)?.catch?.(fail));
  settingsModal.querySelector('[data-voice-test]')?.addEventListener('click', () => speak(s.voiceSample, { interrupt: true }));
}

/** What a beginner needs instead of six numbers: the two things the hero is best at. */
function goodAt(c) {
  const best = Object.keys(c.abilities).sort((a, b) => c.abilities[b] - c.abilities[a]).slice(0, 2);
  return `<div class="muted">${esc(t().goodAt)}: ${best.map((a) => esc(t().abilityNames[a])).join(', ')}, ${c.skills.slice(0, 3).map((k) => esc(skillName(k))).join(', ')}</div>`;
}

// ---- Resources & life status -------------------------------------------------

function resourceName(r) {
  const s = t();
  const lv = level();
  const override = lv === 'beginner' ? s.resourcesBeginner[r.id] : lv === 'intermediate' ? s.resourcesExpert[r.id] : undefined;
  if (override) return override;
  const base = s.resources[r.id];
  if (!base) return r.name;
  const die = r.id === 'hit-dice' && lv === 'intermediate' ? /\(d\d+\)/.exec(r.name)?.[0] : null;
  return die ? `${base} ${die}` : base;
}

const visibleResources = (c) => (c.resources ?? []).filter((r) => !(isBeginner() && r.id === 'hit-dice'));
const pips = (left, total, cls = '') => `<span class="pip ${cls}">${'●'.repeat(Math.max(0, left))}${'○'.repeat(Math.max(0, total - left))}</span>`;

function resourceRow(r) {
  const left = r.max - r.used;
  return `<div class="res"><span>${esc(resourceName(r))}</span>${r.unit === 'hp' ? `<span class="pip">${left}/${r.max}</span>` : pips(left, r.max)}</div>`;
}

function deathSaveRows(c) {
  const labels = t().deathSaves[level()];
  const ds = c.deathSaves ?? { successes: 0, failures: 0 };
  return `<div class="ds"><span>${esc(labels.ok)} ${pips(ds.successes, 3, 'ok')}</span><span>${esc(labels.no)} ${pips(ds.failures, 3, 'no')}</span></div>`;
}

function statsBlock(c) {
  if (isBeginner()) return goodAt(c);
  return `<div class="stats">${Object.keys(t().abilities).map((a) => `
    <div title="${esc(t().abilityNames[a])}"><small>${t().abilities[a]}</small><b>${c.abilities[a]}</b><em>${sign(mod(c.abilities[a]))}</em></div>`).join('')}</div>`;
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------

function renderLobby() {
  const s = t();
  const when = (iso) => new Date(iso).toLocaleString(cfg.language === 'fi' ? 'fi-FI' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  app.innerHTML = `
    <div class="topbar"><span class="brand">${esc(s.appTitle)}</span><span class="scene"></span>${settingsButton()}</div>
    <div class="page">
      <div class="welcome"><h1>${esc(s.appTitle)}</h1><p>${esc(s.tagline)}</p></div>
      <div class="card">
        <h2>${esc(s.newGame)}</h2>
        <form class="row" id="new-game">
          <input class="input" name="title" placeholder="${esc(s.adventureName)}" required>
          <button class="btn primary">${esc(s.create)}</button>
        </form>
      </div>
      <div class="card">
        <h2>${esc(s.savedGames)}</h2>
        ${cfg.games.length ? `<ul class="games">${cfg.games.map((g) => `
          <li><span class="title">${esc(g.title)}</span><span class="when">${esc(s.lastPlayed)} ${when(g.updatedAt)}</span>
          <button class="btn small" data-open="${g.id}">${esc(s.continueGame)}</button></li>`).join('')}</ul>` : `<p class="muted">${esc(s.noGames)}</p>`}
      </div>
      <div class="card connect">
        <b>${esc(s.connectHint)}</b>
        <code>claude mcp add --transport http dnd ${location.origin}/mcp</code>
        <code>/mcp__dnd__dm</code>
      </div>
    </div>`;
  bindCommon(app);
  app.querySelector('#new-game').onsubmit = async (e) => {
    e.preventDefault();
    const title = new FormData(e.target).get('title');
    try {
      const g = await api('/api/games', { title });
      await openGame(g.id, false);
    } catch (err) { fail(err); }
  };
  app.querySelectorAll('[data-open]').forEach((b) => b.onclick = () => openGame(b.dataset.open).catch(fail));
}

// ---------------------------------------------------------------------------
// Party setup & character wizard
// ---------------------------------------------------------------------------

function renderSetup() {
  const s = t();
  app.innerHTML = `
    <div class="topbar"><button class="ghost" data-go-lobby>← ${esc(s.lobby)}</button>
      <span class="scene"><b>${esc(live.title)}</b></span>${dmStatusPill()}${settingsButton()}</div>
    <div class="page">
      <h1>${esc(s.party)}</h1>
      <div class="party-grid">${live.characters.map((c) => `
        <div class="card"><h3>${esc(c.name)}</h3>
          <div class="muted">${esc(raceName(c))} · ${esc(className(c))}${c.player ? ` · ${esc(c.player)}` : ''}</div>
          ${statsBlock(c)}
          <div class="muted">${s.hp} ${c.maxHp} · ${s.ac} ${c.ac} · ${s.speed} ${c.speed}</div>
        </div>`).join('')}
      </div>
      <div class="row">
        <button class="btn" id="add-char">+ ${esc(s.addCharacter)}</button>
        <span style="flex:1"></span>
        <button class="btn primary" id="begin" ${live.characters.length ? '' : 'disabled'}>${esc(s.beginAdventure)} →</button>
      </div>
      ${live.characters.length ? '' : `<p class="muted">${esc(s.needCharacter)}</p>`}
    </div>`;
  bindCommon(app);
  app.querySelector('#add-char').onclick = () => openWizard();
  app.querySelector('#begin').onclick = () => api(`/api/games/${gameId}/start`, {}).catch(fail);
}

function openWizard() {
  const choice = { name: '', player: '', race: null, className: null, preset: 'specialist' };
  let step = 0;
  const modal = document.createElement('div');
  modal.className = 'modal';
  document.body.appendChild(modal);
  const close = () => modal.remove();

  const valid = () => [choice.name.trim(), choice.race, choice.className, choice.preset, true][step];

  async function draw() {
    const s = t();
    const titles = [s.stepWho, s.stepRace, s.stepClass, s.stepPreset, s.stepReview];
    let body = '';
    if (step === 0) {
      body = `<label>${esc(s.charName)}<input class="input" id="w-name" value="${esc(choice.name)}" autofocus></label>
        <p></p><label>${esc(s.playerName)}<input class="input" id="w-player" value="${esc(choice.player)}"></label>`;
    } else if (step === 1 || step === 2) {
      const [list, group, key] = step === 1 ? [rules.races, 'races', 'race'] : [rules.classes, 'classes', 'className'];
      body = `<div class="choice-grid">${list.map((item) => {
        const [name, blurb] = ruleText(group, item);
        return `<button class="choice ${choice[key] === item.id ? 'on' : ''}" data-pick="${item.id}"><b>${esc(name)}</b><span>${esc(blurb)}</span></button>`;
      }).join('')}</div>`;
    } else if (step === 3) {
      const preview = await api('/api/character-preview', { ...choice, name: choice.name || '?' });
      body = `<div class="choice-grid">${rules.presets.map((p) => {
        const [name, blurb] = ruleText('presets', p);
        return `<button class="choice ${choice.preset === p.id ? 'on' : ''}" data-pick="${p.id}"><b>${esc(name)}</b><span>${esc(blurb)}</span></button>`;
      }).join('')}</div>${statsBlock(preview)}
      <div class="muted">${s.hp} ${preview.maxHp}${isBeginner() ? '' : ` · ${s.ac} ${preview.ac}`}</div>`;
    } else {
      const c = await api('/api/character-preview', choice);
      body = sheetHtml(c);
    }
    modal.innerHTML = `<div class="card">
      <div class="wizard-steps">${titles.map((_, i) => `<i class="${i <= step ? 'on' : ''}"></i>`).join('')}</div>
      <h2>${esc(titles[step])}</h2>${body}
      <div class="wizard-nav">
        <button class="btn" id="w-back">${esc(step ? s.back : s.cancel)}</button>
        <button class="btn primary" id="w-next" ${valid() ? '' : 'disabled'}>${esc(step === 4 ? s.createCharacter : s.next)}</button>
      </div></div>`;

    const name = modal.querySelector('#w-name');
    if (name) {
      name.focus();
      const sync = () => { choice.name = name.value; choice.player = modal.querySelector('#w-player').value; modal.querySelector('#w-next').disabled = !valid(); };
      name.oninput = sync;
      modal.querySelector('#w-player').oninput = sync;
    }
    modal.querySelectorAll('[data-pick]').forEach((b) => b.onclick = () => {
      choice[['', 'race', 'className', 'preset'][step]] = b.dataset.pick;
      draw();
    });
    modal.querySelector('#w-back').onclick = () => { if (step) { step--; draw(); } else close(); };
    modal.querySelector('#w-next').onclick = async () => {
      if (step < 4) { step++; return draw(); }
      try { await api(`/api/games/${gameId}/characters`, choice); close(); } catch (err) { fail(err); }
    };
  }
  modal.onclick = (e) => { if (e.target === modal) close(); };
  draw().catch(fail);
}

function sheetHtml(c) {
  const s = t();
  return `<div class="sheet">
    <div class="muted">${esc(raceName(c))} · ${esc(className(c))} · ${s.level} ${c.level}${c.player ? ` · ${esc(c.player)}` : ''}</div>
    ${statsBlock(c)}
    <div><b>${s.hp}</b> ${c.hp}/${c.maxHp}${c.tempHp ? ` (+${c.tempHp})` : ''}${isBeginner() ? '' : ` · <b>${s.ac}</b> ${c.ac} <span class="muted">(${esc(c.acNote)})</span> · <b>${s.speed}</b> ${c.speed}`} · <b>${s.gold}</b> ${c.gold}${isBeginner() ? '' : ` · <b>${s.xp}</b> ${c.xp}`}</div>
    ${visibleResources(c).length ? `<h3>${esc(s.usesLeft)}</h3><ul class="res-list">${visibleResources(c).map((r) => `<li>${resourceRow(r)}<small class="muted">${esc(s.recharge[r.recharge]?.[level()] ?? '')}</small></li>`).join('')}</ul>` : ''}
    ${c.conditions.length ? `<h3>${s.conditions}</h3><div>${condList(c.conditions)}</div>` : ''}
    <h3>${s.skills}</h3><div>${c.skills.map((k) => esc(skillName(k))).join(', ')}</div>
    ${isExpert() ? `<h3>${s.saves}</h3><div>${c.saves.map((a) => s.abilityNames[a]).join(', ')}</div><div class="muted">+${c.proficiencyBonus} proficiency</div>` : ''}
    <h3>${s.inventory}</h3><ul>${c.inventory.map((i) => `<li>${esc(i.name)}${i.qty > 1 ? ` ×${i.qty}` : ''}</li>`).join('')}</ul>
    <h3>${s.features}</h3><ul>${c.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
    ${c.notes ? `<h3>${s.notes}</h3><p>${esc(c.notes)}</p>` : ''}
  </div>`;
}

function showSheet(c) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `<div class="card"><h2>${esc(c.name)}</h2>${sheetHtml(c)}<div class="wizard-nav"><span></span><button class="btn">OK</button></div></div>`;
  modal.onclick = (e) => { if (e.target === modal || e.target.tagName === 'BUTTON') modal.remove(); };
  document.body.appendChild(modal);
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

function dmStatusPill() {
  const st = live?.dmStatus ?? 'offline';
  const label = { offline: t().dmOffline, listening: t().dmListening, thinking: t().dmThinking }[st];
  return `<span class="dm-status ${st}">${esc(label)}</span>`;
}

function renderTable() {
  // Build the frame once; later refreshes only patch regions so typing isn't interrupted.
  if (!app.querySelector('.table-view') || app.dataset.lang !== cfg.language) {
    app.dataset.lang = cfg.language;
    app.innerHTML = `<div class="table-view">
      <div class="topbar" id="topbar"></div>
      <div id="timeline"></div>
      <div class="main"><div class="story" id="story"></div><div class="canvas-wrap" id="canvas"></div></div>
      <div class="party" id="party"></div>
      <div class="bottom"><div class="rolls" id="rolls"></div><div id="composer"></div></div>
    </div>`;
    renderComposer();
  }
  app.querySelector('.table-view').classList.toggle('past', viewSeq !== null);
  renderTopbar();
  renderTimeline();
  renderStory();
  renderCanvas();
  renderParty();
  renderRolls();
  updateComposer();
}

function renderTopbar() {
  const s = t();
  const scene = shown.scene;
  const el = app.querySelector('#topbar');
  el.innerHTML = `<button class="ghost" data-go-lobby>← ${esc(s.lobby)}</button>
    <span class="scene"><b>${esc(shown.title)}</b>${scene ? ` — ${esc(scene.title)}` : ''}</span>
    ${shown.combat ? `<span class="round">${esc(shown.combat.round === 0 ? s.combat.fight : s.combat.round(shown.combat.round))}</span>` : ''}
    ${dmStatusPill()}
    ${settingsButton()}`;
  bindCommon(el);
}

function renderTimeline() {
  const s = t();
  const el = app.querySelector('#timeline');
  if (!history.length) { el.innerHTML = ''; return; }
  const idx = viewSeq === null ? history.length - 1 : history.findIndex((h) => h.seq === viewSeq);
  const h = history[idx];
  const moment = momentText(h);
  el.innerHTML = `
    ${viewSeq !== null ? `<div class="past-banner">⏳ ${esc(s.viewingPast)}
      <button class="btn primary small" id="tl-continue">${esc(s.continueFromHere)}</button>
      <button class="btn small" id="tl-now">${esc(s.backToNow)}</button></div>` : ''}
    <div class="timeline-bar" title="${esc(s.timelineHint)}">
      <span>⟲ ${esc(s.timeline)}</span>
      <input type="range" min="0" max="${history.length - 1}" value="${idx}" id="tl-range">
      <span class="moment">${viewSeq === null ? esc(s.now) : esc(moment)}</span>
    </div>`;
  const range = el.querySelector('#tl-range');
  range.oninput = () => {
    const i = Number(range.value);
    el.querySelector('.moment').textContent = i === history.length - 1 ? s.now : (() => {
      return momentText(history[i]);
    })();
  };
  range.onchange = () => scrubTo(Number(range.value));
  el.querySelector('#tl-now')?.addEventListener('click', () => scrubTo(history.length - 1));
  el.querySelector('#tl-continue')?.addEventListener('click', async () => {
    if (!confirm(s.continueConfirm)) return;
    try {
      await api(`/api/games/${gameId}/rewind`, { seq: viewSeq });
      viewSeq = null;
      sketchIndex = null;
      await refresh();
    } catch (err) { fail(err); }
  });
}

function momentText(x) {
  const s = t();
  const text = !x.purpose ? x.text
    : x.type === 'roll' ? `${rollLabel(x.purpose, x.label)}: ${x.result}`
    : rollLabel(x.purpose, x.text);
  return `${s.timelineTypes[x.type] ?? ''}${x.who ? ` ${x.who}` : ''}${text ? `: ${text}` : ''}`;
}

/** sys params with engine words (roll names, conditions) swapped for the page's own. */
function localParams({ code, params: p }) {
  if (code === 'rolled' && p.purpose) return { ...p, label: rollLabel(p.purpose, p.label) };
  if (code === 'updated') return { ...p, parts: p.parts.map(([k, v]) => [k, k === 'condOn' || k === 'condOff' ? condName(v) : v]) };
  if (code === 'presenceUpdated') return { ...p, condOn: p.condOn?.map(condName), condOff: p.condOff?.map(condName) };
  return p;
}

async function scrubTo(i) {
  sketchIndex = null;
  if (i >= history.length - 1) {
    viewSeq = null;
    shown = live;
  } else {
    viewSeq = history[i].seq;
    shown = await api(`/api/games/${gameId}/state?at=${viewSeq}`);
  }
  render();
}

function logLine(l) {
  const s = t();
  const who = shown.characters.find((c) => c.id === l.characterId);
  if (l.from === 'system') {
    if (isBeginner() && l.sys?.code === 'rolled') return `<p class="msg system">${esc(s.simpleRolled(localParams(l.sys)))}</p>`;
    if (isBeginner() && l.sys?.code === 'dmRolled') return '';
    const fn = l.sys && s.sys[l.sys.code];
    return `<p class="msg system">${esc(fn ? fn(localParams(l.sys)) : l.text)}</p>`;
  }
  if (l.from === 'dm') {
    return `<p class="msg dm ${l.kind}"><button class="say-btn" data-speak="${l.seq}" title="${esc(s.readAloud)}">🔊</button>${l.kind === 'answer' && who ? `<span class="tag">→ ${esc(who.name)}</span>` : ''}${esc(l.text).replace(/\n/g, '<br>')}</p>`;
  }
  const tag = l.kind === 'action' || l.kind === 'speech' ? '' : `<span class="tag">${esc(s.kinds[l.kind])}</span>`;
  return `<p class="msg player ${l.kind}">${tag}<span class="who">${esc(who?.name ?? '—')}</span><span class="text">${esc(l.text)}</span></p>`;
}

function renderStory() {
  const el = app.querySelector('#story');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  el.innerHTML = shown.log.map(logLine).join('');
  el.querySelectorAll('[data-speak]').forEach((b) => b.onclick = () => {
    const line = shown.log.find((l) => l.seq === Number(b.dataset.speak));
    if (line) speak(line.text, { interrupt: true });
  });
  if (atBottom || viewSeq !== null || !el.dataset.init) el.scrollTop = el.scrollHeight;
  el.dataset.init = '1';
}

function renderCanvas() {
  const s = t();
  const el = app.querySelector('#canvas');
  const list = shown.sketches;
  const latest = list.at(-1);
  // A new sketch always takes over the slot.
  if (latest && latest.seq !== lastSketchSeq && viewSeq === null) sketchIndex = null;
  const i = sketchIndex ?? list.length - 1;
  const k = list[i];
  const isNew = viewSeq === null && k && k === latest && latest.seq > lastSketchSeq && lastSketchSeq !== 0;
  if (el.dataset.key === `${k?.seq}:${viewSeq}`) return;
  el.dataset.key = `${k?.seq}:${viewSeq}`;
  if (viewSeq === null && latest) lastSketchSeq = latest.seq;
  else if (viewSeq === null && !latest) lastSketchSeq = -1;

  el.innerHTML = `<div class="paper">${k ? sketchSvg(k.svg) : `<div class="empty">${esc(s.sketchEmpty)}</div>`}</div>
    <div class="caption">
      <button class="ghost" id="sk-prev" ${i > 0 ? '' : 'disabled'}>‹</button>
      <span class="text">${k ? esc(k.caption) : ''}</span>
      ${list.length > 1 ? `<small class="muted">${s.sketchOf(i + 1, list.length)}</small>` : ''}
      <button class="ghost" id="sk-next" ${i < list.length - 1 ? '' : 'disabled'}>›</button>
    </div>`;
  el.querySelector('#sk-prev').onclick = () => { sketchIndex = i - 1; renderCanvas(); };
  el.querySelector('#sk-next').onclick = () => { sketchIndex = i + 1 >= list.length - 1 ? null : i + 1; renderCanvas(); };
  if (isNew) animateDrawing(el.querySelector('.ink'));
}

function sketchSvg(inner) {
  return `<svg viewBox="0 0 800 500" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <filter id="pencil" x="-5%" y="-5%" width="110%" height="110%">
        <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="7" result="wobble"/>
        <feDisplacementMap in="SourceGraphic" in2="wobble" scale="2.4" xChannelSelector="R" yChannelSelector="G" result="shaky"/>
        <feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="1" seed="3" result="grain"/>
        <feColorMatrix in="grain" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.4 1.25" result="mask"/>
        <feComposite in="shaky" in2="mask" operator="in"/>
      </filter>
    </defs>
    <g class="ink" filter="url(#pencil)" fill="none" stroke="#2b2b2b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.92">${inner}</g>
  </svg>`;
}

/** Strokes appear one after another, as if drawn by hand. */
function animateDrawing(group) {
  if (!group) return;
  const shapes = [...group.querySelectorAll('path, line, polyline, polygon, circle, ellipse, rect')];
  const total = 2600;
  shapes.forEach((sh, n) => {
    let len = 0;
    try { len = sh.getTotalLength(); } catch { return; }
    if (!len) return;
    sh.style.strokeDasharray = `${len}`;
    sh.style.strokeDashoffset = `${len}`;
    const delay = (n / shapes.length) * total;
    sh.style.transition = `stroke-dashoffset ${Math.min(700, 120 + len)}ms ease-out ${delay}ms`;
  });
  group.querySelectorAll('text').forEach((tx) => { tx.style.opacity = '0'; tx.style.transition = `opacity .6s ease ${total}ms`; });
  requestAnimationFrame(() => requestAnimationFrame(() => {
    shapes.forEach((sh) => { sh.style.strokeDashoffset = '0'; });
    group.querySelectorAll('text').forEach((tx) => { tx.style.opacity = '1'; });
  }));
}

/**
 * Everyone in the scene as strip cards. Heroes first, then creatures grouped on (groupId, health) in roster
 * order. During a fight the cards follow combat.order: a group's split cards share one turn number, and
 * anything not in the order goes last without a number. Pure, so it can be tried without a page.
 */
function buildStrip(characters, present, combat) {
  const heroes = characters.map((c) => ({ kind: 'hero', key: `h:${c.id}`, hero: c }));
  const creatures = [];
  for (const p of present ?? []) {
    const key = `g:${p.groupId}:${p.health ?? ''}`;
    let card = creatures.find((x) => x.key === key);
    if (!card) creatures.push(card = { kind: 'creature', key, groupId: p.groupId, side: p.side, health: p.health, members: [] });
    card.members.push(p);
  }
  for (const card of creatures) {
    card.name = card.members[0].name;
    card.defeated = card.members.every((m) => m.defeated);
  }
  if (!combat) return [...heroes, ...creatures];
  const out = [];
  combat.order.forEach((entry, i) => {
    const found = entry.ref.kind === 'hero'
      ? heroes.filter((h) => h.hero.id === entry.ref.id)
      : creatures.filter((g) => g.groupId === entry.ref.groupId);
    for (const card of found) {
      // While initiative is gathered the order is not sorted yet, so no positions to show.
      card.turn = combat.round === 0 ? '…' : i + 1;
      card.active = combat.round > 0 && combat.turn === i;
      out.push(card);
    }
  });
  return [...out, ...[...heroes, ...creatures].filter((c) => !out.includes(c))];
}

const HEALTH_WIDTH = { unhurt: 100, hurt: 75, bloodied: 45, nearDeath: 15, defeated: 0 };

function turnBadge(card) {
  return card.turn === undefined ? '' : `<span class="n">${card.turn}</span>`;
}

function heroCardHtml(card) {
  const s = t();
  const c = card.hero;
  const pct = Math.round((c.hp / c.maxHp) * 100);
  const status = c.status ?? 'up';
  const life = status === 'up' ? '' : s.life[status]?.[level()] ?? '';
  return `<button class="pc hero ${status === 'up' ? '' : status} ${card.active ? 'turn' : ''}" data-sheet="${esc(c.id)}"${card.active ? ` title="${esc(s.combat.turnOf(c.name))}"` : ''}>
    ${turnBadge(card)}
    <div class="name">${esc(c.name)}</div>
    <div class="sub">${esc(raceName(c))} · ${esc(className(c))} ${c.level}${c.player ? ` · ${esc(c.player)}` : ''}${life ? ` · <b class="life">${esc(life)}</b>` : ''}</div>
    <div class="hpbar"><i class="${pct <= 30 ? 'low' : ''}" style="width:${pct}%"></i></div>
    <div class="nums"><span>${s.hp} ${c.hp}/${c.maxHp}${c.tempHp ? ` +${c.tempHp}` : ''}</span>${isBeginner() ? '' : `<span>${s.ac} ${c.ac}</span>`}</div>
    ${status === 'dying' ? deathSaveRows(c) : ''}
    ${status === 'dead' ? '' : visibleResources(c).map(resourceRow).join('')}
    ${c.conditions.length ? `<div class="conds">${condList(c.conditions)}</div>` : ''}
  </button>`;
}

function creatureCardHtml(card) {
  const s = t();
  const word = card.health ? s.health[card.health] ?? card.health : '';
  const conds = [...new Set(card.members.flatMap((m) => m.conditions ?? []))];
  const n = card.members.length;
  return `<button class="pc creature ${esc(card.side)} ${card.defeated ? 'defeated' : ''} ${card.active ? 'turn' : ''}" data-group="${esc(card.groupId)}" data-health="${esc(card.health ?? '')}"${card.active ? ` title="${esc(s.combat.turnOf(card.name))}"` : ''}>
    ${turnBadge(card)}
    <div class="name">${esc(card.name)}${n > 1 ? ` ×${n}` : ''}</div>
    ${word ? `<div class="sub">${esc(word)}</div>
    <div class="hpbar"><i class="${card.health === 'nearDeath' || card.health === 'bloodied' ? 'low' : ''}" style="width:${HEALTH_WIDTH[card.health] ?? 0}%"></i></div>` : ''}
    ${conds.length ? `<div class="conds">${condList(conds)}</div>` : ''}
  </button>`;
}

function renderParty() {
  const el = app.querySelector('#party');
  const cards = buildStrip(shown.characters, shown.present, shown.combat);
  el.innerHTML = cards.map((c) => (c.kind === 'hero' ? heroCardHtml(c) : creatureCardHtml(c))).join('');
  el.querySelectorAll('[data-sheet]').forEach((b) => b.onclick = () => showSheet(shown.characters.find((c) => c.id === b.dataset.sheet)));
  el.querySelectorAll('[data-group]').forEach((b) => b.onclick = () => {
    const card = cards.find((c) => c.kind === 'creature' && c.groupId === b.dataset.group && (c.health ?? '') === b.dataset.health);
    if (card) showPresence(card);
  });
}

function showPresence(card) {
  const s = t();
  const word = card.health ? s.health[card.health] ?? card.health : '';
  const n = card.members.length;
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `<div class="card"><h2>${esc(card.name)}${n > 1 ? ` ×${n}` : ''}</h2>
    ${word ? `<div><b>${esc(word)}</b></div>` : ''}
    ${card.members.map((m) => `<div>
      ${n > 1 ? `<h3>${esc(m.name)}</h3>` : ''}
      ${m.description ? `<p>${esc(m.description)}</p>` : ''}
      ${m.conditions?.length ? `<h3>${esc(s.conditions)}</h3><div>${condList(m.conditions)}</div>` : ''}
    </div>`).join('')}
    <div class="wizard-nav"><span></span><button class="btn">OK</button></div></div>`;
  modal.onclick = (e) => { if (e.target === modal || e.target.tagName === 'BUTTON') modal.remove(); };
  document.body.appendChild(modal);
}

// ---- Dice prompts ----------------------------------------------------------

function diceFor(roll) {
  const m = /^(\d*)d(\d+)$/i.exec(roll.dice.replace(/\s/g, ''));
  const count = m[1] ? Number(m[1]) : 1;
  const sides = Number(m[2]);
  return roll.advantage === 'none' ? { count, sides } : { count: 2, sides: 20 };
}

/** Engine rolls get plain words for beginners and the rules name for everyone else. */
function rollHeading(r, who) {
  const name = who?.name ?? '?';
  if (!r.purpose) return t().rollTitle(name, r.label);
  if (isBeginner()) return r.purpose === 'death_save' ? t().deathSavePrompt(name) : t().initiativePrompt(name);
  return t().rollTitle(name, rollLabel(r.purpose, r.label));
}

function renderRolls() {
  const el = app.querySelector('#rolls');
  const rolls = viewSeq === null ? shown.pendingRolls : [];
  const key = rolls.map((r) => r.rollId).join(',') + cfg.language + cfg.complexity;
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  const s = t();
  el.innerHTML = rolls.map((r) => {
    const who = shown.characters.find((c) => c.id === r.characterId);
    const { count, sides } = diceFor(r);
    const draft = rollDrafts[r.rollId] ?? [];
    const instruction =
      r.advantage === 'advantage' ? s.advantage :
      r.advantage === 'disadvantage' ? s.disadvantage :
      count === 1 ? s.throwOne(`d${sides}`) : s.throwMany(count, `d${sides}`);
    return `<div class="roll" data-roll="${r.rollId}">
      <div class="dice">
        ${Array.from({ length: count }, (_, n) => `<label class="die">
          ${dieSvg(sides, 64)}
          <input type="number" inputmode="numeric" min="1" max="${sides}" data-face="${n}" data-max="${sides}" value="${draft[n] ?? ''}" placeholder="?" aria-label="${esc(s.die)} ${n + 1} (d${sides})">
          <small>${count > 1 ? `${esc(s.die)} ${n + 1} · ` : ''}${s.outOfRange(sides)}</small>
        </label>`).join('')}
      </div>
      <div class="info">
        <h3>🎲 ${esc(rollHeading(r, who))}</h3>
        <div class="how"><b>${esc(instruction)}</b>${isExpert() ? '' : ` · ${esc(`d${sides}`)} = ${esc(s.dieHelp[sides])}`}</div>
        <div class="notes">${esc(s.typeResult)}. ${esc(isBeginner() ? s.bonusAdded : r.modifier ? s.modifierAdded(sign(r.modifier)) : s.noModifier)}${!isBeginner() && r.dc !== undefined && r.dc !== null ? ` ${esc(s.beat(r.dc))}` : ''}</div>
      </div>
      <button class="btn primary submit" disabled>${esc(s.submitRoll)}</button>
    </div>`;
  }).join('');

  el.querySelectorAll('.roll').forEach((box) => {
    const rollId = box.dataset.roll;
    const inputs = [...box.querySelectorAll('input')];
    const submit = box.querySelector('.submit');
    const check = () => {
      let ok = true;
      inputs.forEach((inp) => {
        const v = Number(inp.value);
        const bad = inp.value !== '' && !(Number.isInteger(v) && v >= 1 && v <= Number(inp.dataset.max));
        inp.classList.toggle('bad', bad);
        if (bad || inp.value === '') ok = false;
      });
      rollDrafts[rollId] = inputs.map((i) => i.value);
      submit.disabled = !ok;
      return ok;
    };
    inputs.forEach((inp, n) => {
      inp.oninput = check;
      inp.onkeydown = (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (n < inputs.length - 1) inputs[n + 1].focus(); else if (check()) submit.click();
      };
    });
    submit.onclick = async () => {
      if (!check()) return;
      submit.disabled = true;
      try {
        await api(`/api/games/${gameId}/rolls/${rollId}`, { faces: inputs.map((i) => Number(i.value)) });
        delete rollDrafts[rollId];
      } catch (err) { fail(err); submit.disabled = false; }
    };
    check();
  });
  el.querySelector('input')?.focus();
}

// ---- Composer ----------------------------------------------------------------

function renderComposer() {
  const s = t();
  const el = app.querySelector('#composer');
  el.innerHTML = `<div class="composer">
    <div class="chips" id="speakers"></div>
    <div class="chips">${Object.keys(s.kinds).map((k) => `<button class="chip kind" data-kind="${k}">${esc(s.kinds[k])}</button>`).join('')}</div>
    <div class="row"><textarea class="input" id="say"></textarea><button class="btn primary" id="send">${esc(s.send)}</button></div>
  </div>`;
  const say = el.querySelector('#say');
  el.querySelectorAll('[data-kind]').forEach((b) => b.onclick = () => { kind = b.dataset.kind; updateComposer(); say.focus(); });
  const send = async () => {
    const text = say.value.trim();
    if (!text || viewSeq !== null) return;
    try {
      await api(`/api/games/${gameId}/messages`, { characterId: speaker, kind, text });
      say.value = '';
    } catch (err) { fail(err); }
  };
  el.querySelector('#send').onclick = send;
  say.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
}

function updateComposer() {
  const s = t();
  const el = app.querySelector('#composer');
  if (!shown.characters.some((c) => c.id === speaker)) speaker = shown.characters[0]?.id ?? null;
  el.querySelector('#speakers').innerHTML = `<span class="label">${esc(s.speaker)}</span>` +
    shown.characters.map((c) => `<button class="chip ${c.id === speaker ? 'on' : ''}" data-speaker="${c.id}">${esc(c.name)}</button>`).join('');
  el.querySelectorAll('[data-speaker]').forEach((b) => b.onclick = () => { speaker = b.dataset.speaker; updateComposer(); el.querySelector('#say').focus(); });
  el.querySelectorAll('[data-kind]').forEach((b) => b.classList.toggle('on', b.dataset.kind === kind));
  const say = el.querySelector('#say');
  say.placeholder = s.placeholders[kind];
  const disabled = viewSeq !== null;
  say.disabled = disabled;
  el.querySelector('#send').disabled = disabled;
  el.classList.toggle('hidden', viewSeq !== null);
}

// ---------------------------------------------------------------------------
// DM voice (browser speech synthesis; works offline with installed system voices)
// ---------------------------------------------------------------------------

const speech = window.speechSynthesis;
const LANG_CODES = { en: ['en-GB', 'en-US', 'en'], fi: ['fi-FI', 'fi'] };

function voicesFor(lang) {
  if (!speech) return [];
  return speech.getVoices().filter((v) => LANG_CODES[lang].some((code) => v.lang.toLowerCase().startsWith(code.toLowerCase())));
}

function pickVoice() {
  const list = voicesFor(cfg.language);
  return list.find((v) => v.name === prefs.voiceName?.[cfg.language]) ?? list.find((v) => v.localService) ?? list[0];
}

/** Installed voices for the page's language, as [name, label]. */
function voiceChoices() {
  const list = voicesFor(cfg.language);
  // "Eddy (Finnish (Finland))" → "Eddy"; add the region only where names would clash (en-GB vs en-US).
  const base = (v) => v.name.replace(/\s*\(.*\)\s*$/, '');
  const label = (v) => list.filter((x) => base(x) === base(v)).length > 1 ? `${base(v)} (${v.lang.split(/[-_]/)[1] ?? v.lang})` : base(v);
  return list.map((v) => [v.name, label(v)]);
}

/**
 * Browsers cut long utterances short and may fall back to their default (English) voice
 * when an utterance is queued right after cancel(). So: speak sentence-sized chunks, pin the
 * voice and language on every chunk, and never read with a voice of the wrong language.
 */
let speakQueueTimer = null;
function speak(text, { interrupt = false } = {}) {
  if (!speech) return;
  const voice = pickVoice();
  if (!voice) { console.warn(`No ${cfg.language} voice installed; not reading aloud.`); return; }
  const chunks = [];
  for (const sentence of text.replace(/[*_#`>]/g, '').split(/(?<=[.!?…:])\s+|\n+/)) {
    const last = chunks.at(-1);
    if (last && last.length + sentence.length < 160) chunks[chunks.length - 1] = `${last} ${sentence}`;
    else if (sentence.trim()) chunks.push(sentence.trim());
  }
  const enqueue = () => chunks.forEach((chunk) => {
    const u = new SpeechSynthesisUtterance(chunk);
    u.voice = voice;
    u.lang = voice.lang;
    u.rate = 0.97;
    speech.speak(u);
  });
  if (interrupt) {
    speech.cancel();
    clearTimeout(speakQueueTimer);
    speakQueueTimer = setTimeout(enqueue, 120);
  } else enqueue();
}

function speakNew() {
  const fresh = live.log.filter((l) => l.from === 'dm' && l.seq > spokenSeq && l.kind !== 'ooc');
  spokenSeq = Math.max(spokenSeq, live.seq);
  if (!prefs.voice || viewSeq !== null) return;
  fresh.forEach((l) => speak(l.text));
}

/** The DM's latest turn: everything it said since a player last spoke. */
function latestDmTurn() {
  const lastPlayer = shown.log.findLastIndex((l) => l.from === 'player');
  return shown.log.slice(lastPlayer + 1).filter((l) => l.from === 'dm' && l.kind !== 'ooc');
}

async function savePrefs(patch) {
  const turningOn = patch.voice === true && !prefs.voice;
  prefs = await api('/api/prefs', patch);
  if (!prefs.voice) speech?.cancel();
  // Catch up on what's already on screen, e.g. the opening narration.
  if (turningOn && shown) speak(latestDmTurn().map((l) => l.text).join('\n'), { interrupt: true });
  render();
}

if (speech) speech.onvoiceschanged = drawSettings;

boot().catch(fail);
