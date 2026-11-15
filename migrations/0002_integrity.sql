-- One roster entry per normalised teacher name (prevents split votes from double-adds).
CREATE UNIQUE INDEX IF NOT EXISTS teachers_search_name_unique ON teachers(search_name);
-- A council note text can be added once per teacher (double-click / retry safe).
CREATE UNIQUE INDEX IF NOT EXISTS notes_council_unique ON notes(teacher_id, body_hash) WHERE source = 'council';
