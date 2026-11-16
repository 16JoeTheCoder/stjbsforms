-- Allow up to 10 letters per submission (slot 1..10). SQLite can't alter a CHECK,
-- so rebuild the notes table. note_events references notes(id); defer FK checks.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE notes_new (
  id                    TEXT PRIMARY KEY,
  submission_id         TEXT REFERENCES submissions(id),
  slot                  INTEGER CHECK (slot IS NULL OR slot BETWEEN 1 AND 10),
  teacher_id            TEXT NOT NULL REFERENCES teachers(id),
  source                TEXT NOT NULL CHECK (source IN ('student','council')),
  body                  TEXT NOT NULL,
  display_body          TEXT,
  body_hash             TEXT NOT NULL,
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
  UNIQUE (submission_id, teacher_id),
  UNIQUE (submission_id, body_hash)
);

INSERT INTO notes_new SELECT
  id, submission_id, slot, teacher_id, source, body, display_body, body_hash, char_count, grade_label, class_id,
  status, status_reason, assigned_reviewer_id, assigned_at, reviewed_by, reviewed_at, flags, created_by, version,
  created_at, updated_at
FROM notes;

DROP TABLE notes;
ALTER TABLE notes_new RENAME TO notes;

CREATE INDEX notes_status_created ON notes(status, created_at);
CREATE INDEX notes_teacher_status ON notes(teacher_id, status);
CREATE INDEX notes_reviewer_status ON notes(assigned_reviewer_id, status, created_at);
CREATE INDEX notes_submission ON notes(submission_id);
CREATE INDEX notes_class ON notes(class_id);
CREATE INDEX notes_body_hash ON notes(body_hash);
CREATE UNIQUE INDEX notes_council_unique ON notes(teacher_id, body_hash) WHERE source = 'council';
