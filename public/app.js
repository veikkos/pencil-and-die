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

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
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

/** Forces every region to rebuild (language/complexity changed). */
function rerenderAll() {
  app.dataset.lang = '';
  render();
}

function render() {
  if (view === 'lobby' || !gameId || !live) return renderLobby();
  if (view === 'setup') return renderSetup();
  return renderTable();
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function langToggle() {
  return `<span class="lang">${['en', 'fi'].map((l) => `<button data-lang="${l}" class="${cfg.language === l ? 'on' : ''}">${l.toUpperCase()}</button>`).join('')}</span>`;
}

function complexityPicker() {
  const s = t();
  return `<select class="input" id="complexity" title="${esc(s.levelHints[level()])}" style="width:auto;padding:.2em .4em" aria-label="${esc(s.complexity)}">
    ${Object.keys(s.levels).map((l) => `<option value="${l}" ${l === level() ? 'selected' : ''}>${esc(s.complexity)}: ${esc(s.levels[l])}</option>`).join('')}
  </select>`;
}

function verbosityPicker() {
  const s = t();
  return `<select class="input" id="verbosity" title="${esc(s.verbosityHints[cfg.verbosity])}" style="width:auto;padding:.2em .4em" aria-label="${esc(s.verbosity)}">
    ${[1, 2, 3, 4].map((v) => `<option value="${v}" ${v === cfg.verbosity ? 'selected' : ''}>${esc(s.verbosity)}: ${v}/4 ${esc(s.verbosityLevels[v])}</option>`).join('')}
  </select>`;
}

function bindCommon(root) {
  root.querySelectorAll('#verbosity').forEach((sel) => sel.onchange = () => setVerbosity(Number(sel.value)).catch(fail));
  root.querySelectorAll('[data-lang]').forEach((b) => b.onclick = () => setLanguage(b.dataset.lang).catch(fail));
  root.querySelectorAll('#complexity').forEach((sel) => sel.onchange = () => setComplexity(sel.value).catch(fail));
  root.querySelectorAll('[data-go-lobby]').forEach((b) => b.onclick = async () => { view = 'lobby'; cfg = await api('/api/config'); render(); });
}

/** What a beginner needs instead of six numbers: the two things the hero is best at. */
function goodAt(c) {
  const best = Object.keys(c.abilities).sort((a, b) => c.abilities[b] - c.abilities[a]).slice(0, 2);
  return `<div class="muted">${esc(t().goodAt)}: ${best.map((a) => esc(t().abilityNames[a])).join(', ')}, ${c.skills.slice(0, 3).map((k) => esc(skillName(k))).join(', ')}</div>`;
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
    <div class="topbar"><span class="brand">${esc(s.appTitle)}</span><span class="scene"></span>${verbosityPicker()}${complexityPicker()}${langToggle()}</div>
    <div class="page">
      <div class="hero"><h1>${esc(s.appTitle)}</h1><p>${esc(s.tagline)}</p></div>
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
      <span class="scene"><b>${esc(live.title)}</b></span>${dmStatusPill()}${verbosityPicker()}${complexityPicker()}${langToggle()}</div>
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
    ${c.conditions.length ? `<h3>${s.conditions}</h3><div>${c.conditions.map(esc).join(', ')}</div>` : ''}
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
    ${dmStatusPill()}
    <button class="ghost" id="voice" title="${esc(s.voice)}">${prefs.voice ? '🔊' : '🔈'} ${esc(prefs.voice ? s.voiceOn : s.voiceOff)}</button>
    ${prefs.voice ? voiceSelect() : ''}
    ${verbosityPicker()}${complexityPicker()}
    ${langToggle()}`;
  bindCommon(el);
  el.querySelector('#voice').onclick = () => savePrefs({ voice: !prefs.voice });
  const sel = el.querySelector('#voice-name');
  if (sel) sel.onchange = () => savePrefs({ voiceName: { ...prefs.voiceName, [cfg.language]: voicesFor(cfg.language)[sel.selectedIndex]?.name } });
  el.querySelector('#voice-test')?.addEventListener('click', () => speak(t().voiceSample, { interrupt: true }));
}

function renderTimeline() {
  const s = t();
  const el = app.querySelector('#timeline');
  if (!history.length) { el.innerHTML = ''; return; }
  const idx = viewSeq === null ? history.length - 1 : history.findIndex((h) => h.seq === viewSeq);
  const h = history[idx];
  const moment = `${s.timelineTypes[h.type] ?? ''}${h.who ? ` ${h.who}` : ''}${h.text ? `: ${h.text}` : ''}`;
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
      const x = history[i];
      return `${s.timelineTypes[x.type] ?? ''}${x.who ? ` ${x.who}` : ''}${x.text ? `: ${x.text}` : ''}`;
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
    if (isBeginner() && l.sys?.code === 'rolled') return `<p class="msg system">${esc(s.simpleRolled(l.sys.params))}</p>`;
    if (isBeginner() && l.sys?.code === 'dmRolled') return '';
    const fn = l.sys && s.sys[l.sys.code];
    return `<p class="msg system">${esc(fn ? fn(l.sys.params) : l.text)}</p>`;
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

function renderParty() {
  const s = t();
  const el = app.querySelector('#party');
  el.innerHTML = shown.characters.map((c) => {
    const pct = Math.round((c.hp / c.maxHp) * 100);
    return `<button class="pc ${c.hp === 0 ? 'down' : ''}" data-sheet="${c.id}">
      <div class="name">${esc(c.name)}</div>
      <div class="sub">${esc(raceName(c))} · ${esc(className(c))} ${c.level}${c.player ? ` · ${esc(c.player)}` : ''}</div>
      <div class="hpbar"><i class="${pct <= 30 ? 'low' : ''}" style="width:${pct}%"></i></div>
      <div class="nums"><span>${s.hp} ${c.hp}/${c.maxHp}${c.tempHp ? ` +${c.tempHp}` : ''}</span>${isBeginner() ? '' : `<span>${s.ac} ${c.ac}</span>`}</div>
      ${c.conditions.length ? `<div class="conds">${c.conditions.map(esc).join(', ')}</div>` : ''}
    </button>`;
  }).join('');
  el.querySelectorAll('[data-sheet]').forEach((b) => b.onclick = () => showSheet(shown.characters.find((c) => c.id === b.dataset.sheet)));
}

// ---- Dice prompts ----------------------------------------------------------

function diceFor(roll) {
  const m = /^(\d*)d(\d+)$/i.exec(roll.dice.replace(/\s/g, ''));
  const count = m[1] ? Number(m[1]) : 1;
  const sides = Number(m[2]);
  return roll.advantage === 'none' ? { count, sides } : { count: 2, sides: 20 };
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
        <h3>🎲 ${esc(s.rollTitle(who?.name ?? '?', r.label))}</h3>
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

function voiceSelect() {
  const list = voicesFor(cfg.language);
  if (!list.length) return `<span class="muted" style="font-size:.8em">${esc(t().noVoice)}</span>`;
  const chosen = pickVoice();
  // "Eddy (Finnish (Finland))" → "Eddy"; add the region only where names would clash (en-GB vs en-US).
  const base = (v) => v.name.replace(/\s*\(.*\)\s*$/, '');
  const label = (v) => list.filter((x) => base(x) === base(v)).length > 1 ? `${base(v)} (${v.lang.split(/[-_]/)[1] ?? v.lang})` : base(v);
  return `<select id="voice-name" class="input" style="width:auto;padding:.2em .4em">${list.map((v) =>
    `<option ${v === chosen ? 'selected' : ''}>${esc(label(v))}</option>`).join('')}</select>
    <button class="ghost" id="voice-test" title="${esc(t().testVoice)}">▶︎</button>`;
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

if (speech) speech.onvoiceschanged = () => { if (view === 'table') renderTopbar(); };

boot().catch(fail);
