import { QUESTIONS } from './questions.js';

const PER_DAY = 7;

export function normalize(s) {
  return String(s ?? '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\+/g, ' plus ')
    .replace(/#/g, ' sharp ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(the|a|an) /, '');
}

function withinDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return false;
    prev = cur;
  }
  return prev[b.length] <= max;
}

const indexCache = new Map();
function buildIndex(q) {
  let map = indexCache.get(q.id);
  if (map) return map;
  map = new Map();
  q.answers.forEach((a, i) => {
    for (const variant of [a[0], ...(a[2] || [])]) {
      const k = normalize(variant);
      if (k && !map.has(k)) map.set(k, i);
    }
  });
  indexCache.set(q.id, map);
  return map;
}

/* Returns the index of the matched valid answer, or -1. */
export function matchAnswer(q, raw) {
  const key = normalize(raw);
  if (!key) return -1;
  const map = buildIndex(q);
  if (map.has(key)) return map.get(key);
  if (key.length < 6) return -1;
  const max = key.length >= 11 ? 2 : 1;
  const hits = new Set();
  for (const [k, idx] of map) {
    if (k.length >= 6 && withinDistance(key, k, max)) hits.add(idx);
  }
  return hits.size === 1 ? [...hits][0] : -1;
}

export function tierFor(points) {
  return points >= 80 ? 'Abyssal' : points >= 55 ? 'Deep' : points >= 30 ? 'Shallows' : 'Surface';
}

/* Rarity scoring: real pick counts plus an editorial prior (weight * 2). */
export function scoreAnswers(q, counts) {
  const eff = q.answers.map(a => (counts[a[0]] || 0) + a[1] * 2);
  const max = Math.max(...eff);
  return q.answers.map((a, i) => ({
    answer: a[0],
    points: 10 + Math.round(90 * (1 - eff[i] / max)),
    picks: counts[a[0]] || 0
  }));
}

export function buildReveal(q, counts) {
  return scoreAnswers(q, counts)
    .map(s => ({ answer: s.answer, points: s.points, tier: tierFor(s.points), picks: s.picks }))
    .sort((a, b) => b.points - a.points || a.answer.localeCompare(b.answer));
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(arr, seed) {
  const rnd = mulberry32(seed * 2654435761);
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* Same 7 questions for everybody on a given UTC date; no repeats within a cycle. */
export function questionsForDay(dateStr) {
  const daysPerCycle = Math.max(1, Math.floor(QUESTIONS.length / PER_DAY));
  const dayNumber = Math.floor(Date.parse(dateStr + 'T00:00:00Z') / 86400000);
  const cycle = Math.floor(dayNumber / daysPerCycle);
  const pos = dayNumber % daysPerCycle;
  const order = seededShuffle(QUESTIONS.map((_, i) => i), cycle + 1);
  return order.slice(pos * PER_DAY, pos * PER_DAY + PER_DAY).map(i => QUESTIONS[i]);
}
