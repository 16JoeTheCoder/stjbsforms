-- STJB Teacher's Day platform — initial schema.
-- All timestamps are ISO-8601 UTC strings (e.g. 2026-11-25T03:00:00.000Z).
-- Identifiers are opaque random strings; names/codes are never used as keys.

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE grades (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role          TEXT NOT NULL CHECK (role IN ('admin','reviewer')),
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  is_owner      INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0,1)),
  invited_by    TEXT REFERENCES users(id),
  access_sync   TEXT NOT NULL DEFAULT 'not_configured',
  last_seen_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE classes (
  id                 TEXT PRIMARY KEY,
  grade_id           TEXT NOT NULL REFERENCES grades(id),
  label              TEXT NOT NULL UNIQUE COLLATE NOCASE,
  code_hash          TEXT UNIQUE,           -- HMAC-SHA256(code) for lookup
  code_cipher        TEXT,                  -- AES-GCM ciphertext so admins can re-display
  code_rotated_at    TEXT,
  expected_students  INTEGER NOT NULL DEFAULT 0 CHECK (expected_students >= 0),
  soft_quota         INTEGER NOT NULL DEFAULT 0 CHECK (soft_quota >= 0),
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','disabled')),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX classes_grade ON classes(grade_id);

CREATE TABLE teachers (
  id           TEXT PRIMARY KEY,
  honorific    TEXT NOT NULL DEFAULT '',
  full_name    TEXT NOT NULL,
  search_name  TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX teachers_active ON teachers(active, full_name);

CREATE TABLE awards (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  display_order      INTEGER NOT NULL DEFAULT 0,
  active             INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  winner_teacher_id  TEXT REFERENCES teachers(id),
  winner_note        TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE submissions (
  id               TEXT PRIMARY KEY,
  idempotency_key  TEXT NOT NULL UNIQUE,
  browser_hash     TEXT NOT NULL UNIQUE,      -- HMAC of the HttpOnly browser cookie
  class_id         TEXT NOT NULL REFERENCES classes(id),
  grade_id         TEXT NOT NULL REFERENCES grades(id),
  grade_label      TEXT NOT NULL,             -- snapshot at submission time
  receipt_code     TEXT NOT NULL,
  over_quota       INTEGER NOT NULL DEFAULT 0 CHECK (over_quota IN (0,1)),
  class_position   INTEGER NOT NULL DEFAULT 0, -- nth active submission for class when received
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','voided')),
  void_reason      TEXT,
  voided_by        TEXT REFERENCES users(id),
  voided_at        TEXT,
  flags            TEXT NOT NULL DEFAULT '[]',
  form_version     TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX submissions_class ON submissions(class_id, status, created_at);
CREATE INDEX submissions_created ON submissions(created_at);

CREATE TABLE votes (
  submission_id  TEXT NOT NULL REFERENCES submissions(id),
  award_id       TEXT NOT NULL REFERENCES awards(id),
  teacher_id     TEXT NOT NULL REFERENCES teachers(id),
  PRIMARY KEY (submission_id, award_id),
  UNIQUE (submission_id, teacher_id)          -- a teacher can win at most one award per ballot
);
CREATE INDEX votes_award_teacher ON votes(award_id, teacher_id);

CREATE TABLE notes (
  id                    TEXT PRIMARY KEY,
  submission_id         TEXT REFERENCES submissions(id),  -- NULL for council-written notes
  slot                  INTEGER CHECK (slot IS NULL OR slot BETWEEN 1 AND 3),
  teacher_id            TEXT NOT NULL REFERENCES teachers(id),
  source                TEXT NOT NULL CHECK (source IN ('student','council')),
  body                  TEXT NOT NULL,         -- original text, never modified
  display_body          TEXT,                  -- optional reviewed text used for print
  body_hash             TEXT NOT NULL,         -- SHA-256 of normalised text
  char_count            INTEGER NOT NULL,
  grade_label           TEXT,
  class_id              TEXT REFERENCES classes(id),
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','trashed')),
  status_reason         TEXT,
  assigned_reviewer_id  TEXT REFERENCES users(id),
  assigned_at           TEXT,
  reviewed_by           TEXT REFERENCES users(id),
  reviewed_at           TEXT,
  flags                 TEXT NOT NULL DEFAULT '[]',
  created_by            TEXT REFERENCES users(id),
  version               INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (submission_id, slot),
  UNIQUE (submission_id, teacher_id),        -- three distinct recipients
  UNIQUE (submission_id, body_hash)          -- no identical messages within one submission
);
CREATE INDEX notes_status_created ON notes(status, created_at);
CREATE INDEX notes_teacher_status ON notes(teacher_id, status);
CREATE INDEX notes_reviewer_status ON notes(assigned_reviewer_id, status, created_at);
CREATE INDEX notes_submission ON notes(submission_id);
CREATE INDEX notes_class ON notes(class_id);
CREATE INDEX notes_body_hash ON notes(body_hash);

CREATE TABLE note_events (
  id             TEXT PRIMARY KEY,
  note_id        TEXT NOT NULL REFERENCES notes(id),
  actor_user_id  TEXT REFERENCES users(id),
  action         TEXT NOT NULL,              -- status | assign | edit | create
  prev_status    TEXT,
  new_status     TEXT,
  detail         TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX note_events_note ON note_events(note_id, created_at);

CREATE TABLE audit_log (
  id             TEXT PRIMARY KEY,
  actor_user_id  TEXT REFERENCES users(id),
  actor_email    TEXT,
  action         TEXT NOT NULL,
  entity_type    TEXT NOT NULL,
  entity_id      TEXT,
  detail         TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL
);
CREATE INDEX audit_created ON audit_log(created_at);
CREATE INDEX audit_entity ON audit_log(entity_type, entity_id);

-- Defaults
INSERT INTO settings (key, value) VALUES
  ('submissions_open', 'false'),
  ('opens_at', ''),
  ('closes_at', ''),
  ('reviewer_can_restore', 'true'),
  ('min_notes_per_teacher', '3'),
  ('print_seed', 'teachers-day-2026'),
  ('show_council_label', 'false'),
  ('default_quota_extra', '5'),
  ('form_version', '1');

INSERT INTO grades (id, label, sort_order) VALUES
  ('g_sec1', 'Sec 1', 1),
  ('g_sec2', 'Sec 2', 2),
  ('g_sec3', 'Sec 3', 3),
  ('g_sec4', 'Sec 4', 4),
  ('g_jc1',  'JC1',   5),
  ('g_jc2',  'JC2',   6);

INSERT INTO awards (id, name, description, display_order, created_at, updated_at) VALUES
  ('aw_asleep',  'Most Likely to Fall Asleep While Grading', '', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('aw_lost',    'Most Likely to Get Lost During a Field Trip', '', 2, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('aw_retire',  'Most Likely to Never Retire', '', 3, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('aw_student', 'Most Likely to Be Mistaken for a Student', '', 4, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('aw_parent',  'Most Likely to Be Accidentally Called Mom/Dad', '', 5, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('aw_rap',     'Most Likely to Win a Rap Battle', '', 6, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
