CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pw_hash TEXT NOT NULL,
  pw_salt TEXT NOT NULL,
  pw_iter INTEGER NOT NULL DEFAULT 100000,
  created_at INTEGER NOT NULL,
  current_streak INTEGER NOT NULL DEFAULT 0,
  best_streak INTEGER NOT NULL DEFAULT 0,
  last_completed TEXT,
  total_points INTEGER NOT NULL DEFAULT 0,
  games_played INTEGER NOT NULL DEFAULT 0,
  best_score INTEGER NOT NULL DEFAULT 0,
  practice_played INTEGER NOT NULL DEFAULT 0,
  practice_correct INTEGER NOT NULL DEFAULT 0,
  practice_points INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS daily_games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  question_ids TEXT NOT NULL,
  answered INTEGER NOT NULL DEFAULT 0,
  correct INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE (user_id, day)
);
CREATE INDEX IF NOT EXISTS idx_games_day_score ON daily_games(day, completed, score DESC);

CREATE TABLE IF NOT EXISTS daily_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  q_index INTEGER NOT NULL,
  question_id TEXT NOT NULL,
  raw_answer TEXT NOT NULL,
  matched TEXT,
  points INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, day, q_index)
);
CREATE INDEX IF NOT EXISTS idx_answers_user ON daily_answers(user_id);

CREATE TABLE IF NOT EXISTS answer_stats (
  question_id TEXT NOT NULL,
  answer_key TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (question_id, answer_key)
);

CREATE TABLE IF NOT EXISTS practice_rounds (
  id TEXT PRIMARY KEY,
  user_id INTEGER,
  question_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  answered INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
