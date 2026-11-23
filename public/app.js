'use strict';
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');
const TOTAL = 7;
const TIERS = ['Surface', 'Shallows', 'Deep', 'Abyssal'];
const TIER_EMOJI = { Surface: '🟦', Shallows: '🟩', Deep: '🟨', Abyssal: '🟪' };
const tierClass = t => (t ? 't-' + String(t).toLowerCase() : 't-miss');

let me = null;
let renderToken = 0;
const ui = {
  daily: null, dailyResult: null, lb: 'daily',
  practice: { round: null, result: null, seen: [], n: 0, points: 0, correct: 0 }
};

/* ---------- helpers ---------- */
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin'
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* no body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || 'Something went wrong. Please try again.');
    err.status = res.status;
    throw err;
  }
  return data;
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 3200);
}
const logo = (s = 40) => `<svg class="logo" width="${s}" height="${s}" viewBox="0 0 64 64" role="img" aria-label="Neegy the golden diver fish">
<defs><linearGradient id="ng${s}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffe08a"/><stop offset="1" stop-color="#f0a92e"/></linearGradient></defs>
<circle cx="32" cy="32" r="30" fill="#06223a" stroke="#1d5478" stroke-width="1.5"/>
<path d="M14 32 L4 21 L4 43 Z" fill="url(#ng${s})"/>
<ellipse cx="34" cy="33" rx="20" ry="15" fill="url(#ng${s})"/>
<path d="M30 18 Q34 11 40 18 Z" fill="#f0a92e"/>
<circle cx="41" cy="30" r="10.5" fill="#0a2e4d" stroke="#8fe3f2" stroke-width="2"/>
<circle cx="44" cy="28" r="3.4" fill="#fff"/><circle cx="45" cy="28.6" r="1.6" fill="#06223a"/>
<path d="M36 25 Q40 22 44 22" stroke="#8fe3f2" stroke-width="1.4" fill="none" stroke-linecap="round" opacity=".7"/>
<circle cx="53" cy="13" r="2.6" fill="none" stroke="#8fe3f2" stroke-width="1.3"/><circle cx="48" cy="8" r="1.6" fill="none" stroke="#8fe3f2" stroke-width="1.2"/>
</svg>`;
const loading = () => '<div class="card skeleton"></div>';
function loginPrompt(title, text) {
  return `<section class="card center fade-up"><h2>${esc(title)}</h2><p class="muted">${esc(text)}</p>
  <div class="row" style="justify-content:center;margin-top:14px"><button class="btn primary" data-action="open-auth" data-mode="signup">Create account</button><button class="btn" data-action="open-auth" data-mode="login">Sign in</button></div></section>`;
}
function errorView(e) {
  app.innerHTML = `<section class="card center"><h2>Couldn’t load this page</h2><p class="muted">${esc(e.message)}</p><button class="btn primary" data-action="retry">Try again</button></section>`;
}
function animateCounts() {
  document.querySelectorAll('[data-count]').forEach(el => {
    const target = Number(el.dataset.count) || 0;
    if (target === 0 || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = target; return; }
    const start = performance.now(), dur = 800;
    const step = now => {
      const p = Math.min(1, (now - start) / dur);
      el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}
function tick() {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const s = Math.max(0, Math.floor((next - now) / 1000));
  const t = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map(n => String(n).padStart(2, '0')).join(':');
  document.querySelectorAll('[data-countdown]').forEach(el => { el.textContent = t; });
  if (s === 0) setTimeout(route, 1500);
}
setInterval(tick, 1000);
const countdown = () => `<span data-countdown>--:--:--</span>`;
function renderAuthButton() {
  const b = $('#auth-btn');
  b.textContent = me ? me.username : 'Sign in';
  b.dataset.action = me ? 'go-stats' : 'open-auth';
}
function syncMe() {
  if (!me || !ui.daily || ui.daily.needsLogin) return;
  me.today = { answered: ui.daily.answered, score: ui.daily.score, completed: ui.daily.completed };
  if (ui.daily.streak) me.streak = ui.daily.streak.current;
}

/* ---------- auth modal ---------- */
function openAuth(mode = 'login') {
  const signup = mode === 'signup';
  $('#modal-root').innerHTML = `<div class="modal-back" data-action="close-modal"><div class="modal card" role="dialog" aria-modal="true" aria-labelledby="auth-title">
  <h2 id="auth-title">${signup ? 'Create your account' : 'Welcome back'}</h2>
  <form data-form="auth" data-mode="${mode}">
    <label>Username<input name="username" required minlength="3" maxlength="20" pattern="[A-Za-z0-9_]+" autocomplete="username" autocapitalize="off" spellcheck="false"></label>
    <label>Password<input name="password" type="password" required minlength="8" maxlength="128" autocomplete="${signup ? 'new-password' : 'current-password'}"></label>
    <p class="form-error" role="alert"></p>
    <button class="btn primary block">${signup ? 'Create account' : 'Sign in'}</button>
  </form>
  <p class="muted center" style="margin-top:14px">${signup ? 'Already have an account?' : 'New here?'} <button class="link" data-action="open-auth" data-mode="${signup ? 'login' : 'signup'}">${signup ? 'Sign in' : 'Create an account'}</button></p>
  ${signup ? '<p class="tiny muted center">3–20 letters, numbers or underscores. Password: 8+ characters. There is no email on file, so passwords cannot be reset — keep yours safe.</p>' : ''}
  </div></div>`;
  setTimeout(() => { const i = $('#modal-root input'); if (i) i.focus(); }, 60);
}
const closeModal = () => { $('#modal-root').innerHTML = ''; };

/* ---------- shared result view ---------- */
function resultCard(r, nextLabel, nextAction) {
  const hit = !!r.matched;
  return `<section class="card result fade-up">
  <p class="eyebrow">${esc(r.prompt || '')}</p>
  <div class="score-pop ${tierClass(r.tier)}"><span data-count="${r.points}">0</span><small>pts</small></div>
  ${hit
    ? `<p class="verdict">${esc(r.matched)} <span class="badge ${tierClass(r.tier)}">${esc(r.tier)}</span></p>
       <p class="muted">${r.picks > 0 ? `${r.picks} other ${r.picks === 1 ? 'diver has' : 'divers have'} found this answer.` : 'Nobody has logged this answer yet — a true deep find.'}</p>`
    : `<p class="verdict miss">${r.answer ? '“' + esc(r.answer) + '” isn’t on the list' : 'Passed'}</p><p class="muted">No points this time.</p>`}
  <h3 class="sub">Every valid answer</h3>
  <div class="chips">${r.reveal.map(a => `<span class="chip ${tierClass(a.tier)}${a.answer === r.matched ? ' hit' : ''}">${esc(a.answer)} <b>${a.points}</b></span>`).join('')}</div>
  <button class="btn primary block" data-action="${nextAction}">${esc(nextLabel)}</button>
  </section>`;
}
function answerForm(kind, placeholder) {
  return `<form data-form="${kind}" autocomplete="off">
  <input id="answer" name="answer" type="text" maxlength="80" placeholder="${esc(placeholder)}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Your answer" required>
  <div class="row"><button class="btn primary" type="submit">Dive</button><button class="btn ghost" type="button" data-action="${kind === 'daily-answer' ? 'daily-pass' : 'practice-pass'}">Pass</button></div></form>`;
}

/* ---------- pages ---------- */
async function pageHome() {
  const t = me && me.today;
  let label = 'Start today’s dive', status = 'Sign in to save your score, streak and rank.';
  if (me && t.completed) { label = 'See today’s results'; status = `Today’s dive complete · ${t.score} pts`; }
  else if (me && t.answered > 0) { label = `Continue dive (${t.answered}/${TOTAL})`; status = 'Your dive is waiting.'; }
  else if (me) { status = 'A fresh dive is ready.'; }
  app.innerHTML = `
  <section class="card hero fade-up">
    ${logo(96)}
    <h1>Neegy Dive</h1>
    <p class="lead">Seven questions. Type your answers. The rarer the answer, the deeper you score.</p>
    <a class="btn primary lg" href="#/daily">${esc(label)}</a>
    <p class="status">${esc(status)}</p>
    <p class="status">Next dive in ${countdown()} UTC reset</p>
    ${me ? `<p class="streak-line">Streak: ${me.streak} day${me.streak === 1 ? '' : 's'}</p>` : ''}
  </section>
  <a class="card feature fade-up" href="#/unlimited" style="animation-delay:.08s"><h3>Unlimited Dive</h3><p class="muted">Practice with endless random questions. Same rarity scoring, no daily limit.</p></a>
  <a class="card feature fade-up" href="#/leaderboard" style="animation-delay:.16s"><h3>Leaderboards</h3><p class="muted">Today’s top divers, all-time points and the longest live streaks.</p></a>
  <a class="card feature fade-up" href="#/how" style="animation-delay:.24s"><h3>How scoring works</h3><p class="muted">Common answers score little. Rare-but-correct answers score big.</p></a>`;
}

async function pageDaily(_, tok) {
  if (!me) { app.innerHTML = loginPrompt('Sign in to dive', 'Your daily score, streak and leaderboard spot need an account.'); return; }
  app.innerHTML = loading();
  const d = await api('/daily');
  if (tok !== renderToken) return;
  ui.daily = d; ui.dailyResult = null; syncMe(); drawDaily();
}
function drawDaily() {
  const d = ui.daily;
  if (ui.dailyResult) {
    const r = ui.dailyResult;
    const last = d.completed;
    app.innerHTML = `<div class="dots">${Array.from({ length: TOTAL }, (_, i) => `<i class="${i < d.answered ? 'done' : ''}"></i>`).join('')}</div>` +
      resultCard(r, last ? 'See final score' : 'Next question', 'daily-next');
    animateCounts(); return;
  }
  if (d.completed) { drawDailySummary(); return; }
  const c = d.current;
  app.innerHTML = `<section class="card q-card fade-up">
  <div class="dots">${Array.from({ length: TOTAL }, (_, i) => `<i class="${i < d.answered ? 'done' : i === d.answered ? 'now' : ''}"></i>`).join('')}</div>
  <p class="eyebrow">Question ${c.index + 1} of ${TOTAL} · ${esc(c.category)}</p>
  <h1 class="prompt">${esc(c.prompt)}</h1>
  ${answerForm('daily-answer', 'Type your answer')}
  <p class="hint">One guess per question. Many answers are valid — rarer ones score more. Score so far: <b>${d.score}</b></p>
  </section>`;
  const i = $('#answer'); if (i) i.focus();
}
function drawDailySummary() {
  const d = ui.daily;
  const rows = d.results.map(r => `<li class="sum-row ${tierClass(r.tier)}"><span class="n">${r.index + 1}</span>
  <div><div class="q">${esc(r.prompt)}</div><div class="a">${r.matched ? esc(r.matched) : (r.answer ? '<s>' + esc(r.answer) + '</s>' : 'Passed')}</div></div><span class="pts">${r.points}</span></li>`).join('');
  app.innerHTML = `<section class="card center fade-up">
  <p class="eyebrow">Dive complete · ${esc(d.day)}</p>
  <div class="big-score"><span data-count="${d.score}">0</span><small>/ ${TOTAL * 100}</small></div>
  <p class="streak-line">Streak: ${d.streak.current} day${d.streak.current === 1 ? '' : 's'} · best ${d.streak.best}</p>
  <ul class="sum-list">${rows}</ul>
  <div class="row" style="justify-content:center"><button class="btn primary" data-action="share-daily">Share result</button><a class="btn" href="#/leaderboard">Leaderboard</a></div>
  <p class="hint">Next dive in ${countdown()}</p>
  <p class="hint"><a href="#/unlimited">Keep practising in Unlimited mode →</a></p></section>`;
  animateCounts(); tick();
}
function shareText() {
  const d = ui.daily;
  const sq = d.results.map(r => (r.tier ? TIER_EMOJI[r.tier] : '⬛')).join('');
  return `Neegy Dive ${d.day}\n${d.score}/${TOTAL * 100} · ${d.streak.current}-day streak\n${sq}\n${location.origin}`;
}
async function submitDaily(payload) {
  const btns = app.querySelectorAll('button'); btns.forEach(b => { b.disabled = true; });
  try {
    const res = await api('/daily/answer', { method: 'POST', body: { index: ui.daily.current.index, ...payload } });
    ui.daily = res.state; ui.dailyResult = res.result; syncMe(); drawDaily();
  } catch (e) {
    toast(e.message);
    if (e.status === 409 || e.status === 401) { route(); } else { btns.forEach(b => { b.disabled = false; }); }
  }
}

async function pagePractice() {
  const p = ui.practice;
  if (p.round || p.result) { drawPractice(); return; }
  app.innerHTML = `<section class="card center fade-up"><p class="eyebrow">Unlimited Dive</p><h1>Train in the open water</h1>
  <p class="muted">Endless random questions with the same rarity scoring. ${me ? 'Your practice totals are saved to your profile.' : 'Sign in to save practice stats to your profile.'}</p>
  <button class="btn primary lg" data-action="practice-start" style="margin-top:14px">Start diving</button></section>`;
}
async function startPractice() {
  const p = ui.practice;
  app.innerHTML = loading();
  try {
    const r = await api('/practice/start', { method: 'POST', body: { exclude: p.seen.slice(-25) } });
    p.round = r; p.result = null; p.seen.push(r.qid); drawPractice();
  } catch (e) { toast(e.message); pagePractice(); }
}
function sessionBar() {
  const p = ui.practice;
  return `<div class="session-bar"><span>Answered <b>${p.n}</b></span><span>Found <b>${p.correct}</b></span><span>Points <b>${p.points}</b></span></div>`;
}
function drawPractice() {
  const p = ui.practice;
  if (p.result) { app.innerHTML = sessionBar() + resultCard(p.result, 'Next question', 'practice-next'); animateCounts(); return; }
  app.innerHTML = sessionBar() + `<section class="card q-card fade-up"><p class="eyebrow">Unlimited · ${esc(p.round.category)}</p>
  <h1 class="prompt">${esc(p.round.prompt)}</h1>${answerForm('practice-answer', 'Type your answer')}
  <p class="hint">One guess per question.</p></section>`;
  const i = $('#answer'); if (i) i.focus();
}
async function submitPractice(payload) {
  const p = ui.practice;
  const btns = app.querySelectorAll('button'); btns.forEach(b => { b.disabled = true; });
  try {
    const res = await api('/practice/answer', { method: 'POST', body: { roundId: p.round.roundId, ...payload } });
    p.n++; p.points += res.points; if (res.matched) p.correct++;
    p.result = res; p.round = null; drawPractice();
  } catch (e) {
    toast(e.message);
    if (e.status === 404 || e.status === 409) { p.round = null; p.result = null; pagePractice(); } else { btns.forEach(b => { b.disabled = false; }); }
  }
}

async function pageLeaderboard(_, tok) {
  app.innerHTML = loading();
  const data = await api('/leaderboard?type=' + ui.lb);
  if (tok !== renderToken) return;
  const tabs = [['daily', 'Today'], ['alltime', 'All-time'], ['streak', 'Streaks']];
  const unit = { daily: 'pts', alltime: 'pts', streak: 'days' }[ui.lb];
  const rows = data.rows.map((r, i) => `<li class="lb-row ${me && me.username.toLowerCase() === r.username.toLowerCase() ? 'me' : ''}" style="animation-delay:${Math.min(i, 12) * 30}ms">
    <span class="rank">${i + 1}</span><a href="#/profile/${encodeURIComponent(r.username)}">${esc(r.username)}</a>
    <span class="val">${r.value} ${unit}<small>${esc(r.sub)}</small></span></li>`).join('');
  const emptyMsg = { daily: 'Nobody has finished today’s dive yet. Be the first!', alltime: 'No completed dives yet.', streak: 'No active streaks right now.' }[ui.lb];
  app.innerHTML = `<section class="card fade-up"><h2>Leaderboard</h2>
  <div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${ui.lb === k}" class="${ui.lb === k ? 'on' : ''}" data-action="lb-tab" data-tab="${k}">${l}</button>`).join('')}</div>
  ${data.rows.length ? `<ol class="lb">${rows}</ol>` : `<p class="muted center">${emptyMsg}</p>`}
  <p class="tiny muted center" style="margin-top:12px">${ui.lb === 'daily' ? 'Resets at 00:00 UTC. Only completed dives are ranked.' : ui.lb === 'streak' ? 'Streaks count consecutive UTC days with a completed dive.' : 'Total points from completed daily dives.'}</p></section>`;
}

async function pageStats(_, tok) {
  if (!me) { app.innerHTML = loginPrompt('Your profile awaits', 'Sign in to see your statistics, streaks and rarity breakdown.'); return; }
  await renderProfile(me.username, true, tok);
}
async function pageProfile(name, tok) {
  if (!name) { location.hash = '#/stats'; return; }
  await renderProfile(name, !!me && me.username.toLowerCase() === name.toLowerCase(), tok);
}
const tile = (l, v, s = '') => `<div class="tile"><div class="l">${esc(l)}</div><div class="v">${esc(v)}</div>${s ? `<div class="s">${esc(s)}</div>` : ''}</div>`;
async function renderProfile(name, own, tok) {
  app.innerHTML = loading();
  const p = await api('/profile/' + encodeURIComponent(name));
  if (tok !== renderToken) return;
  const totalFound = TIERS.reduce((n, t) => n + (p.tiers[t] || 0), 0);
  const bars = TIERS.map(t => {
    const c = p.tiers[t] || 0, pct = totalFound ? Math.round((c / totalFound) * 100) : 0;
    return `<div class="bar-row ${tierClass(t)}"><span>${t}</span><div class="bar"><i style="--w:${pct}%"></i></div><b>${c}</b></div>`;
  }).join('');
  const recent = p.recent.map(g => `<div class="recent-row"><span>${esc(g.day.slice(5))}</span><div class="bar"><i style="--w:${Math.round(g.score / (TOTAL * 100) * 100)}%"></i></div><b>${g.score}</b></div>`).join('');
  app.innerHTML = `<section class="card fade-up"><div class="profile-head"><div><p class="eyebrow">${own ? 'Your profile' : 'Diver profile'}</p><h1>${esc(p.username)}</h1>
  <p class="muted">Diving since ${new Date(p.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</p></div>
  ${own ? '<button class="btn small" data-action="logout">Log out</button>' : ''}</div></section>
  <section class="grid fade-up" style="margin-bottom:16px">
    ${tile('Current streak', p.streak, 'days')}${tile('Best streak', p.bestStreak, 'days')}
    ${tile('Dives completed', p.gamesPlayed)}${tile('Total points', p.totalPoints)}
    ${tile('Average score', p.average, 'per dive')}${tile('Best score', p.bestScore, `of ${TOTAL * 100}`)}
    ${tile('Accuracy', p.accuracy + '%', 'daily answers found')}${tile('Practice points', p.practice.points, `${p.practice.correct}/${p.practice.played} found`)}
  </section>
  <section class="card fade-up"><h2>Rarity of your finds</h2>${totalFound ? bars : '<p class="muted">Complete a daily dive to see your rarity breakdown.</p>'}
  ${p.rarest ? `<p class="hint">Rarest find: <b>${esc(p.rarest.answer)}</b> (${p.rarest.points} pts) — “${esc(p.rarest.prompt)}”</p>` : ''}</section>
  <section class="card fade-up"><h2>Recent dives</h2>${p.recent.length ? recent : '<p class="muted">No completed dives yet.</p>'}</section>`;
}

function pageHow() {
  app.innerHTML = `<section class="card how fade-up"><h1>How to play</h1>
  <ol><li>Every day (00:00 UTC) a new dive of <b>${TOTAL} questions</b> drops — the same for everyone.</li>
  <li><b>Type</b> an answer. Most questions have many valid answers, and small typos and common alternate spellings are accepted.</li>
  <li>You get <b>one guess</b> per question. Wrong or passed answers score 0.</li>
  <li>Finish all ${TOTAL} to lock in your score, extend your streak and join the leaderboard.</li></ol>
  <h3>Rarity scoring</h3>
  <p class="muted">Each valid answer is worth 10–100 points. The more players choose an answer, the less it is worth; the more unusual, the more it pays. A perfect dive is ${TOTAL * 100}.</p>
  <div class="legend"><span class="chip t-surface">Surface <b>10–29</b></span><span class="chip t-shallows">Shallows <b>30–54</b></span><span class="chip t-deep">Deep <b>55–79</b></span><span class="chip t-abyssal">Abyssal <b>80–100</b></span></div>
  <p class="hint">Rarity is calculated from how real players answer. Before an answer has any history, it starts from our editorial estimate and shifts to real player data as people play.</p>
  <h3>Streaks</h3><p class="muted">Complete a daily dive on consecutive UTC days to build your streak. Miss a whole day and it resets to 1 on your next completed dive.</p>
  <h3>Unlimited mode</h3><p class="muted">Endless random questions with the same scoring. Practice never affects your daily score, streak or the daily leaderboard, and it doesn’t change rarity data.</p>
  <h3>Fair play</h3><p class="muted">All answers are checked and scored on the server, and each question can only be answered once. Accounts use a username and password — no email, so no password resets.</p>
  <a class="btn primary" href="#/daily">Start diving</a></section>`;
}

/* ---------- router ---------- */
const routes = { '': pageHome, daily: pageDaily, unlimited: pagePractice, leaderboard: pageLeaderboard, stats: pageStats, how: pageHow, profile: pageProfile };
async function route() {
  const tok = ++renderToken;
  const [name = '', arg = ''] = location.hash.replace(/^#\/?/, '').split('/');
  const fn = routes[name] || pageHome;
  const navKey = name === '' || !routes[name] ? 'home' : (name === 'profile' ? 'stats' : name);
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === navKey));
  window.scrollTo(0, 0);
  try { await fn(decodeURIComponent(arg), tok); } catch (e) { if (tok === renderToken) errorView(e); }
  if (tok === renderToken) { animateCounts(); tick(); }
}

/* ---------- events ---------- */
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  if (a === 'close-modal') { if (e.target === el) closeModal(); return; }
  if (a === 'open-auth') { openAuth(el.dataset.mode || 'login'); return; }
  if (a === 'go-stats') { location.hash = '#/stats'; return; }
  if (a === 'retry') { route(); return; }
  if (a === 'lb-tab') { ui.lb = el.dataset.tab; route(); return; }
  if (a === 'logout') {
    try { await api('/auth/logout', { method: 'POST', body: {} }); } catch (_) { /* ignore */ }
    me = null; ui.daily = null; ui.dailyResult = null; renderAuthButton(); location.hash = '#/'; route(); toast('Logged out.'); return;
  }
  if (a === 'daily-pass') { submitDaily({ pass: true }); return; }
  if (a === 'daily-next') { ui.dailyResult = null; drawDaily(); return; }
  if (a === 'share-daily') {
    const text = shareText();
    try {
      if (navigator.share) await navigator.share({ text });
      else { await navigator.clipboard.writeText(text); toast('Result copied to clipboard.'); }
    } catch (_) { /* cancelled */ }
    return;
  }
  if (a === 'practice-start' || a === 'practice-next') { ui.practice.round = null; ui.practice.result = null; startPractice(); return; }
  if (a === 'practice-pass') { submitPractice({ pass: true }); return; }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
document.addEventListener('submit', async e => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  const kind = f.dataset.form;
  if (kind === 'auth') {
    const err = $('.form-error', f), btn = $('button', f);
    err.textContent = ''; btn.disabled = true;
    try {
      const res = await api('/auth/' + f.dataset.mode, { method: 'POST', body: { username: f.elements.username.value.trim(), password: f.elements.password.value } });
      me = res.user; closeModal(); renderAuthButton(); route(); toast('Welcome aboard, ' + me.username + '!');
    } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    return;
  }
  const answer = f.elements.answer.value.trim();
  if (!answer) return;
  if (kind === 'daily-answer') submitDaily({ answer });
  if (kind === 'practice-answer') submitPractice({ answer });
});
window.addEventListener('hashchange', route);

/* ---------- boot ---------- */
(async function init() {
  $('#brand-logo').innerHTML = logo(34);
  try { me = (await api('/me')).user; } catch (_) { me = null; }
  renderAuthButton();
  route();
})();
