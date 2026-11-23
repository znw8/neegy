import {
  HttpError, json, todayStr, addDays, randomHex, randomInt, sha256Hex,
  pbkdf2Hex, safeEqual, getCookie
} from '../_lib/util.js';
import { QUESTIONS, QUESTIONS_BY_ID } from '../_lib/questions.js';
import { matchAnswer, scoreAnswers, buildReveal, tierFor, questionsForDay } from '../_lib/game.js';

const TOTAL = 7;
const COOKIE = 'nd_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '').replace(/\/+$/, '') || '/';
  const method = request.method;
  try {
    if (!env.DB) throw new HttpError(500, 'The database is not connected yet. Add the D1 binding named DB in Cloudflare (see README).');
    if (method !== 'GET' && method !== 'HEAD') {
      const origin = request.headers.get('Origin');
      if (origin) {
        let host = '';
        try { host = new URL(origin).host; } catch (_) { /* bad origin */ }
        if (host !== url.host) throw new HttpError(403, 'Cross-site requests are not allowed.');
      }
    }
    const user = await getUser(request, env);
    const ctx = { request, env, url, user };
    const route = `${method} ${path}`;

    if (route === 'POST /auth/signup') return await signup(ctx);
    if (route === 'POST /auth/login') return await login(ctx);
    if (route === 'POST /auth/logout') return await logout(ctx);
    if (route === 'GET /me') return json({ user: user ? await summary(env, user) : null });
    if (route === 'GET /daily') return await dailyGet(ctx);
    if (route === 'POST /daily/answer') return await dailyAnswer(ctx);
    if (route === 'POST /practice/start') return await practiceStart(ctx);
    if (route === 'POST /practice/answer') return await practiceAnswer(ctx);
    if (route === 'GET /leaderboard') return await leaderboard(ctx);
    if (method === 'GET' && path.startsWith('/profile/')) return await profile(ctx, decodeURIComponent(path.slice(9)));
    if (route === 'GET /health') return json({ ok: true });
    throw new HttpError(404, 'Not found.');
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error('Unhandled error:', e && e.stack ? e.stack : e);
    return json({ error: 'Server error. Please try again.' }, 500);
  }
}

/* ---------- helpers ---------- */
const ip = request => request.headers.get('CF-Connecting-IP') || 'unknown';

async function readBody(request, optional = false) {
  const text = await request.text();
  if (text.length > 4000) throw new HttpError(413, 'Request too large.');
  if (!text) { if (optional) return {}; throw new HttpError(400, 'Missing request body.'); }
  let body;
  try { body = JSON.parse(text); } catch (_) { throw new HttpError(400, 'Invalid JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Invalid request body.');
  return body;
}

async function rateLimit(env, key, max, windowSec) {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare('SELECT count, window_start FROM rate_limits WHERE key = ?').bind(key).first();
  if (!row || now - row.window_start > windowSec) {
    await env.DB.prepare('INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = 1, window_start = excluded.window_start').bind(key, now).run();
    return;
  }
  if (row.count >= max) throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');
  await env.DB.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').bind(key).run();
}

function iterations(env) {
  const n = parseInt(env.PBKDF2_ITERATIONS, 10);
  return Number.isFinite(n) ? Math.min(100000, Math.max(10000, n)) : 100000;
}

async function getUser(request, env) {
  const token = getCookie(request, COOKIE);
  if (!token || token.length !== 64) return null;
  const hash = await sha256Hex(token);
  return await env.DB.prepare(
    'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?'
  ).bind(hash, Date.now()).first();
}

async function createSession(env, userId) {
  const token = randomHex(32);
  const now = Date.now();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), userId, now, now + SESSION_MS).run();
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MS / 1000}`;
}

function effectiveStreak(u) {
  const t = todayStr();
  return u.last_completed === t || u.last_completed === addDays(t, -1) ? u.current_streak : 0;
}

async function summary(env, u) {
  const g = await env.DB.prepare('SELECT answered, score, completed FROM daily_games WHERE user_id = ? AND day = ?').bind(u.id, todayStr()).first();
  return {
    username: u.username,
    createdAt: u.created_at,
    streak: effectiveStreak(u),
    bestStreak: u.best_streak,
    today: g ? { answered: g.answered, score: g.score, completed: !!g.completed } : { answered: 0, score: 0, completed: false }
  };
}

async function loadCounts(env, ids) {
  const out = {};
  if (!ids.length) return out;
  const unique = [...new Set(ids)];
  const ph = unique.map(() => '?').join(',');
  const { results } = await env.DB.prepare(`SELECT question_id, answer_key, count FROM answer_stats WHERE question_id IN (${ph})`).bind(...unique).all();
  for (const r of results) (out[r.question_id] ||= {})[r.answer_key] = r.count;
  return out;
}

const upsertStat = (env, qid, key) => env.DB.prepare(
  'INSERT INTO answer_stats (question_id, answer_key, count) VALUES (?, ?, 1) ON CONFLICT(question_id, answer_key) DO UPDATE SET count = count + 1'
).bind(qid, key);

function cleanAnswer(body) {
  const pass = body.pass === true;
  const raw = pass ? '' : String(body.answer ?? '').trim().slice(0, 80);
  if (!pass && !raw) throw new HttpError(400, 'Please type an answer.');
  return { pass, raw };
}

/* ---------- auth ---------- */
async function signup({ request, env }) {
  const body = await readBody(request);
  const username = String(body.username ?? '').trim();
  const password = String(body.password ?? '');
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) throw new HttpError(400, 'Username must be 3–20 letters, numbers or underscores.');
  if (password.length < 8 || password.length > 128) throw new HttpError(400, 'Password must be 8–128 characters.');
  await rateLimit(env, `auth:${ip(request)}`, 20, 600);
  const exists = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (exists) throw new HttpError(409, 'That username is taken.');
  const salt = randomHex(16);
  const iter = iterations(env);
  const hash = await pbkdf2Hex(password, salt, iter);
  let res;
  try {
    res = await env.DB.prepare('INSERT INTO users (username, pw_hash, pw_salt, pw_iter, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(username, hash, salt, iter, Date.now()).run();
  } catch (_) { throw new HttpError(409, 'That username is taken.'); }
  const userId = res.meta.last_row_id;
  const cookie = await createSession(env, userId);
  const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
  return json({ user: await summary(env, u) }, 201, { 'Set-Cookie': cookie });
}

async function login({ request, env }) {
  const body = await readBody(request);
  const username = String(body.username ?? '').trim();
  const password = String(body.password ?? '');
  if (!username || !password || password.length > 128) throw new HttpError(400, 'Enter your username and password.');
  await rateLimit(env, `auth:${ip(request)}`, 20, 600);
  const u = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
  const salt = u ? u.pw_salt : '00000000000000000000000000000000';
  const iter = u ? u.pw_iter : iterations(env);
  const hash = await pbkdf2Hex(password, salt, iter);
  if (!u || !safeEqual(hash, u.pw_hash)) throw new HttpError(401, 'Incorrect username or password.');
  if (Math.random() < 0.05) {
    await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()).run();
  }
  const cookie = await createSession(env, u.id);
  return json({ user: await summary(env, u) }, 200, { 'Set-Cookie': cookie });
}

async function logout({ request, env }) {
  const token = getCookie(request, COOKIE);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
}

/* ---------- daily ---------- */
async function ensureGame(env, user, day) {
  let game = await env.DB.prepare('SELECT * FROM daily_games WHERE user_id = ? AND day = ?').bind(user.id, day).first();
  if (!game) {
    const ids = questionsForDay(day).map(q => q.id);
    await env.DB.prepare('INSERT OR IGNORE INTO daily_games (user_id, day, question_ids, started_at) VALUES (?, ?, ?, ?)')
      .bind(user.id, day, JSON.stringify(ids), Date.now()).run();
    game = await env.DB.prepare('SELECT * FROM daily_games WHERE user_id = ? AND day = ?').bind(user.id, day).first();
  }
  return game;
}

async function dailyState(env, user, game) {
  const ids = JSON.parse(game.question_ids);
  const { results: rows } = await env.DB.prepare(
    'SELECT q_index, question_id, raw_answer, matched, points FROM daily_answers WHERE user_id = ? AND day = ? ORDER BY q_index'
  ).bind(user.id, game.day).all();
  const counts = await loadCounts(env, rows.map(r => r.question_id));
  const results = rows.map(r => {
    const q = QUESTIONS_BY_ID.get(r.question_id);
    return {
      index: r.q_index, prompt: q.prompt, category: q.cat, answer: r.raw_answer, matched: r.matched,
      points: r.points, tier: r.matched ? tierFor(r.points) : null, reveal: buildReveal(q, counts[q.id] || {})
    };
  });
  let current = null;
  if (!game.completed && game.answered < TOTAL) {
    const q = QUESTIONS_BY_ID.get(ids[game.answered]);
    current = { index: game.answered, prompt: q.prompt, category: q.cat };
  }
  const fresh = await env.DB.prepare('SELECT current_streak, best_streak, last_completed FROM users WHERE id = ?').bind(user.id).first();
  return {
    day: game.day, total: TOTAL, answered: game.answered, score: game.score, completed: !!game.completed,
    current, results, streak: { current: effectiveStreak(fresh), best: fresh.best_streak }
  };
}

async function dailyGet({ env, user }) {
  const day = todayStr();
  if (!user) return json({ day, total: TOTAL, needsLogin: true });
  const game = await ensureGame(env, user, day);
  return json(await dailyState(env, user, game));
}

async function dailyAnswer({ request, env, user }) {
  if (!user) throw new HttpError(401, 'Please sign in to play the daily dive.');
  const body = await readBody(request);
  const index = body.index;
  if (!Number.isInteger(index) || index < 0 || index >= TOTAL) throw new HttpError(400, 'Invalid question.');
  const { pass, raw } = cleanAnswer(body);
  const day = todayStr();
  const game = await ensureGame(env, user, day);
  if (game.completed) throw new HttpError(409, 'You already finished today’s dive.');
  if (index !== game.answered) throw new HttpError(409, 'That question was already answered. Refreshing your dive…');

  const ids = JSON.parse(game.question_ids);
  const q = QUESTIONS_BY_ID.get(ids[index]);
  if (!q) throw new HttpError(500, 'Question data is missing.');
  const hitIdx = pass ? -1 : matchAnswer(q, raw);
  const counts = (await loadCounts(env, [q.id]))[q.id] || {};
  const scored = scoreAnswers(q, counts);
  const points = hitIdx >= 0 ? scored[hitIdx].points : 0;
  const matched = hitIdx >= 0 ? q.answers[hitIdx][0] : null;

  const stmts = [
    env.DB.prepare('INSERT INTO daily_answers (user_id, day, q_index, question_id, raw_answer, matched, points, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(user.id, day, index, q.id, raw, matched, points, Date.now()),
    env.DB.prepare('UPDATE daily_games SET answered = answered + 1, score = score + ?, correct = correct + ? WHERE id = ? AND answered = ?')
      .bind(points, hitIdx >= 0 ? 1 : 0, game.id, index)
  ];
  if (hitIdx >= 0) stmts.push(upsertStat(env, q.id, matched));
  if (index === TOTAL - 1) {
    const yesterday = addDays(day, -1);
    const streak = user.last_completed === yesterday ? user.current_streak + 1 : 1;
    const finalScore = game.score + points;
    stmts.push(env.DB.prepare('UPDATE daily_games SET completed = 1, completed_at = ? WHERE id = ?').bind(Date.now(), game.id));
    stmts.push(env.DB.prepare(
      'UPDATE users SET current_streak = ?, best_streak = MAX(best_streak, ?), last_completed = ?, total_points = total_points + ?, games_played = games_played + 1, best_score = MAX(best_score, ?) WHERE id = ?'
    ).bind(streak, streak, day, finalScore, finalScore, user.id));
  }
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    throw new HttpError(409, 'That question was already answered. Refreshing your dive…');
  }

  const updated = await env.DB.prepare('SELECT * FROM daily_games WHERE id = ?').bind(game.id).first();
  return json({
    result: {
      index, prompt: q.prompt, answer: raw, matched, points, tier: matched ? tierFor(points) : null,
      picks: hitIdx >= 0 ? scored[hitIdx].picks : 0, reveal: buildReveal(q, counts)
    },
    state: await dailyState(env, user, updated)
  });
}

/* ---------- practice ---------- */
async function practiceStart({ request, env, user }) {
  await rateLimit(env, `practice:${ip(request)}`, 400, 600);
  const body = await readBody(request, true);
  const exclude = new Set(Array.isArray(body.exclude) ? body.exclude.slice(0, 30).map(String) : []);
  let pool = QUESTIONS.filter(q => !exclude.has(q.id));
  if (!pool.length) pool = QUESTIONS;
  const q = pool[randomInt(pool.length)];
  const id = randomHex(16);
  await env.DB.prepare('INSERT INTO practice_rounds (id, user_id, question_id, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, user ? user.id : null, q.id, Date.now()).run();
  if (Math.random() < 0.05) {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM practice_rounds WHERE created_at < ?').bind(now - 86400000),
      env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(Math.floor(now / 1000) - 86400)
    ]);
  }
  return json({ roundId: id, qid: q.id, prompt: q.prompt, category: q.cat });
}

async function practiceAnswer({ request, env, user }) {
  await rateLimit(env, `practice:${ip(request)}`, 400, 600);
  const body = await readBody(request);
  const roundId = String(body.roundId ?? '');
  if (!/^[0-9a-f]{32}$/.test(roundId)) throw new HttpError(400, 'Invalid round.');
  const { pass, raw } = cleanAnswer(body);
  const round = await env.DB.prepare('SELECT * FROM practice_rounds WHERE id = ?').bind(roundId).first();
  if (!round) throw new HttpError(404, 'That round expired. Starting a new one…');
  if ((round.user_id ?? null) !== (user ? user.id : null)) throw new HttpError(403, 'That round belongs to another session.');
  const claim = await env.DB.prepare('UPDATE practice_rounds SET answered = 1 WHERE id = ? AND answered = 0').bind(roundId).run();
  if (!claim.meta.changes) throw new HttpError(409, 'That question was already answered.');

  const q = QUESTIONS_BY_ID.get(round.question_id);
  const hitIdx = pass ? -1 : matchAnswer(q, raw);
  const counts = (await loadCounts(env, [q.id]))[q.id] || {};
  const scored = scoreAnswers(q, counts);
  const points = hitIdx >= 0 ? scored[hitIdx].points : 0;
  const matched = hitIdx >= 0 ? q.answers[hitIdx][0] : null;
  if (user) {
    await env.DB.prepare('UPDATE users SET practice_played = practice_played + 1, practice_correct = practice_correct + ?, practice_points = practice_points + ? WHERE id = ?')
      .bind(hitIdx >= 0 ? 1 : 0, points, user.id).run();
  }
  return json({
    prompt: q.prompt, answer: raw, matched, points, tier: matched ? tierFor(points) : null,
    picks: hitIdx >= 0 ? scored[hitIdx].picks : 0, reveal: buildReveal(q, counts)
  });
}

/* ---------- leaderboard & profile ---------- */
async function leaderboard({ env, url }) {
  const type = url.searchParams.get('type') || 'daily';
  let rows = [];
  if (type === 'daily') {
    const { results } = await env.DB.prepare(
      'SELECT u.username, g.score, g.correct FROM daily_games g JOIN users u ON u.id = g.user_id WHERE g.day = ? AND g.completed = 1 ORDER BY g.score DESC, g.completed_at ASC LIMIT 50'
    ).bind(todayStr()).all();
    rows = results.map(r => ({ username: r.username, value: r.score, sub: `${r.correct}/${TOTAL} found` }));
  } else if (type === 'alltime') {
    const { results } = await env.DB.prepare(
      'SELECT username, total_points, games_played FROM users WHERE games_played > 0 ORDER BY total_points DESC, games_played ASC, id ASC LIMIT 50'
    ).all();
    rows = results.map(r => ({ username: r.username, value: r.total_points, sub: `${r.games_played} dive${r.games_played === 1 ? '' : 's'}` }));
  } else if (type === 'streak') {
    const { results } = await env.DB.prepare(
      'SELECT username, current_streak, best_streak FROM users WHERE current_streak > 0 AND last_completed >= ? ORDER BY current_streak DESC, best_streak DESC, id ASC LIMIT 50'
    ).bind(addDays(todayStr(), -1)).all();
    rows = results.map(r => ({ username: r.username, value: r.current_streak, sub: `best ${r.best_streak}` }));
  } else {
    throw new HttpError(400, 'Unknown leaderboard.');
  }
  return json({ type, rows });
}

async function profile({ env }, username) {
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) throw new HttpError(404, 'Diver not found.');
  const u = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
  if (!u) throw new HttpError(404, 'Diver not found.');
  const [agg, found, recent] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS answered FROM daily_answers WHERE user_id = ?').bind(u.id).first(),
    env.DB.prepare('SELECT question_id, matched, points FROM daily_answers WHERE user_id = ? AND matched IS NOT NULL ORDER BY points DESC LIMIT 5000').bind(u.id).all(),
    env.DB.prepare('SELECT day, score, correct FROM daily_games WHERE user_id = ? AND completed = 1 ORDER BY day DESC LIMIT 14').bind(u.id).all()
  ]);
  const tiers = { Surface: 0, Shallows: 0, Deep: 0, Abyssal: 0 };
  for (const r of found.results) tiers[tierFor(r.points)]++;
  const top = found.results[0];
  return json({
    username: u.username,
    createdAt: u.created_at,
    streak: effectiveStreak(u),
    bestStreak: u.best_streak,
    gamesPlayed: u.games_played,
    totalPoints: u.total_points,
    bestScore: u.best_score,
    average: u.games_played ? Math.round(u.total_points / u.games_played) : 0,
    accuracy: agg.answered ? Math.round((found.results.length / agg.answered) * 100) : 0,
    tiers,
    rarest: top ? { answer: top.matched, points: top.points, prompt: (QUESTIONS_BY_ID.get(top.question_id) || {}).prompt || '' } : null,
    recent: recent.results,
    practice: { played: u.practice_played, correct: u.practice_correct, points: u.practice_points }
  });
}
