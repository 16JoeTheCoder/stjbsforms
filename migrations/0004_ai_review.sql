-- External AI review: exports record which note versions were handed out, so an
-- import only ever changes notes that are still pending and unchanged since export.
CREATE TABLE ai_review_exports (
  id             TEXT PRIMARY KEY,
  created_at     TEXT NOT NULL,
  created_by     TEXT REFERENCES users(id),
  note_count     INTEGER NOT NULL,
  note_versions  TEXT NOT NULL            -- JSON object: { "<note id>": <version> }
);
CREATE INDEX ai_review_exports_created ON ai_review_exports(created_at);

CREATE TABLE ai_review_imports (
  id          TEXT PRIMARY KEY,
  export_id   TEXT NOT NULL REFERENCES ai_review_exports(id),
  created_at  TEXT NOT NULL,
  created_by  TEXT REFERENCES users(id),
  approved    INTEGER NOT NULL DEFAULT 0,
  trashed     INTEGER NOT NULL DEFAULT 0,
  unsure      INTEGER NOT NULL DEFAULT 0,
  skipped     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ai_review_imports_export ON ai_review_imports(export_id);

-- Every decision the AI returned, kept for traceability (applied or not).
CREATE TABLE ai_review_decisions (
  import_id         TEXT NOT NULL REFERENCES ai_review_imports(id),
  note_id           TEXT NOT NULL REFERENCES notes(id),
  decision          TEXT NOT NULL CHECK (decision IN ('approve','trash','unsure')),
  reason            TEXT,
  expected_version  INTEGER NOT NULL,
  PRIMARY KEY (import_id, note_id)
);
