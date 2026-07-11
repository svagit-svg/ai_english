-- Migration number: 0001 	 2026-07-11T12:45:07.218Z

CREATE TABLE IF NOT EXISTS users (
  telegram_id     INTEGER PRIMARY KEY,
  username        TEXT NOT NULL DEFAULT '',
  first_name      TEXT NOT NULL DEFAULT '',

  xp              INTEGER NOT NULL DEFAULT 0,
  lessons         INTEGER NOT NULL DEFAULT 0,
  dialogs         INTEGER NOT NULL DEFAULT 0,
  streak          INTEGER NOT NULL DEFAULT 0,
  last_date       TEXT NOT NULL DEFAULT '',

  daily_activity  TEXT NOT NULL DEFAULT '{}',
  history         TEXT NOT NULL DEFAULT '[]',
  course_progress TEXT NOT NULL DEFAULT '{}',
  vocab           TEXT NOT NULL DEFAULT '[]',
  mistakes        TEXT NOT NULL DEFAULT '[]',
  achievements    TEXT NOT NULL DEFAULT '[]',
  freezes         TEXT NOT NULL DEFAULT '{}',
  dc_streak       TEXT NOT NULL DEFAULT '{}',

  pro             INTEGER NOT NULL DEFAULT 0,
  pro_until       INTEGER NOT NULL DEFAULT 0,
  trial_start     INTEGER NOT NULL DEFAULT 0,
  onboarded       INTEGER NOT NULL DEFAULT 0,
  level           TEXT NOT NULL DEFAULT '',
  goal            TEXT NOT NULL DEFAULT '',
  reminder_time   TEXT NOT NULL DEFAULT '',

  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_xp ON users (xp DESC);
