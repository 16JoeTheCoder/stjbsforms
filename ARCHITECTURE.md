# Architecture

One Cloudflare Worker serves everything: the React SPA (Workers Static Assets) and a JSON API (Hono) backed by D1.

```
Browser ──► thanks.stjbscouncil.com ───────┐
                                           ├─► Worker "stjb-thanks" ──► D1 (SQLite)
Browser ──► Access (email OTP) ──► thanks-admin.stjbscouncil.com ┘      ├─► Turnstile Siteverify
                                                                         └─► Rate Limiting bindings
```

## Repository layout

| Path | What |
|---|---|
| `src/worker/` | Worker: `index.ts` (routing, headers), `auth.ts` (Access JWT, roles, host gating, CSRF), `routes/` (public, review, admin), `lib/` (db helpers, crypto, notes, Access sync) |
| `src/shared/` | Code used by both sides: zod schemas, text rules (grapheme counting, normalisation), teacher search, class codes, seeded shuffle, API types |
| `src/client/student/` | Student form: draft store (`draft.ts`), state machine + submit (`StudentApp.tsx`), steps |
| `src/client/staff/` | Admin shell and pages, reviewer queue |
| `src/client/components/` | `TeacherPicker` (Downshift combobox), Turnstile, dialogs |
| `src/client/pdf/` | Print engine (pdf-lib + fontkit), font loading, WOFF→sfnt |
| `migrations/` | D1 SQL migrations (additive only) |
| `test/unit`, `test/worker`, `e2e/` | Vitest (Node), Vitest in workerd with real D1, Playwright |

## Request routing and segregation

- `assets.run_worker_first: ["/api/*"]` — API calls always hit the Worker; everything else is a static asset with SPA fallback.
- **Public API** `/api/public/*`: config, form data (teachers/awards only), class-code check, submission, receipt lookup.
- **Staff API** `/api/me`, `/api/review/*`, `/api/admin/*`, all guarded by `requireRole`:
  1. Host must equal `ADMIN_HOST` (else 404). This covers `workers.dev`, preview URLs and the public host.
  2. `Cf-Access-Jwt-Assertion` is verified with `jose` against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, checking RS256, issuer, audience (`ACCESS_AUD`) and expiry.
  3. The verified email must be an **active** row in `users`; the role must be allowed for the route.
- Mutations require same-origin `Origin` (or `Sec-Fetch-Site: same-origin`). No CORS headers are ever sent.
- The development identity shortcut (`x-dev-user`) needs `ENVIRONMENT === "development"` **and** a localhost host.

Access protects the whole staff hostname at the edge (including static files). `ctx.access` isn't used because Workers with Static Assets don't receive it.

## Roles

| Capability | Reviewer | Admin |
|---|---|---|
| Own assigned notes: read, approve, trash, back to pending (restore only if setting allows) | ✓ | ✓ |
| See grade level of a note | ✓ | ✓ |
| See class, submission, reviewer identities, timestamps | – | ✓ |
| Award results, classes and codes, teachers, users, settings, exports, audit | – | ✓ |

Reviewer responses never include class ids, submission ids or exact timestamps, and reviewer lists are ordered by random note id, so a student's three notes can't be linked by time.

## Data model (D1)

`settings`, `grades`, `users`, `classes`, `teachers`, `awards`, `submissions`, `votes`, `notes`, `note_events`, `audit_log` — see `migrations/0001_init.sql`.

Key constraints:

- `submissions.idempotency_key UNIQUE` makes retries safe. `submissions.browser_hash UNIQUE` means one submission per browser (an HMAC of the HttpOnly cookie, never the raw value).
- `votes PRIMARY KEY (submission_id, award_id)` + `UNIQUE (submission_id, teacher_id)` means one vote per award and six distinct teachers.
- `notes UNIQUE (submission_id, slot)`, `(submission_id, teacher_id)`, `(submission_id, body_hash)` mean three distinct recipients and no identical letters.
- `teachers.search_name UNIQUE`, and council notes are unique per (teacher, text).
- Class codes: `code_hash` (HMAC, for lookup) + `code_cipher` (AES-GCM, so admins can re-display). Neither the code nor the class name is used as a key.
- All ids are random strings; all timestamps are UTC ISO strings; the UI shows Asia/Jakarta.

### Effective visibility

A note **counts** (printing, coverage) iff `status = 'approved'` and (`submission_id IS NULL` or its submission is `active`), and its teacher is active (printing). Voiding a submission only flips `submissions.status`, so restoring it brings back its votes and notes with their moderation states untouched. Award totals join `votes` to active submissions.

## Submission flow

1. Validate (zod, then server rules): event open, class active, exactly one vote per active award, distinct active teachers, 3 distinct recipients, 100–400 graphemes, not identical after NFKC/case/whitespace normalisation.
2. Replay check: same idempotency key returns the original receipt (`duplicate: true`), even after closing.
3. Browser check: a different key from the same browser returns `409 ALREADY_SUBMITTED` (with the earlier receipt).
4. Turnstile Siteverify (last, so validation errors don't burn a token).
5. One `DB.batch` (a transaction): the submission row (over-quota flag and class position computed in SQL), 6 votes, 3 notes. Any constraint failure rolls everything back; a lost race with a concurrent retry returns the winner's receipt.

Soft quotas never reject: submissions beyond the quota are stored with `over_quota = 1` and surfaced to admins.

### Client reliability

- `localStorage` draft, debounced 400 ms, flushed immediately on step changes, tab hide and unload. Unreadable drafts are backed up, never overwritten. Another tab's newer save is adopted.
- The idempotency key is created with the draft and persisted. `pendingSubmit` is set before sending; on an uncertain outcome (network error, 5xx, timeout) the client asks `GET /api/public/submissions/:key` before allowing another send. Success is shown only after the server confirms.
- After success the read-only copy and receipt stay until the student removes them.

## Moderation and concurrency

Status changes use optimistic concurrency: one batch inserts the `note_events` row and updates the note, both guarded by `id = ? AND version = ? AND status != ?` (+ assignment for reviewers). A stale version gets `409` and nothing is written. Bulk changes skip notes already in the target state and log each change.

Assignments: distribute = greedy least-loaded over unassigned pending notes; rebalance = keep each reviewer's oldest up to the target, move only the excess; release = return a reviewer's pending notes. Guards ensure only still-pending notes (and the expected current assignee) are touched; approved/trashed notes are never reassigned. Disabling a user releases their pending notes.

## Abuse controls (proportionate)

- Turnstile on submit (server-verified action and hostname).
- `BROWSER_LIMITER` 30/min per browser cookie; `NETWORK_LIMITER` 10,000/min per IP as a backstop (a whole school may share one IP; the local load test checks 300 students from one IP pass).
- `CODE_MISS_LIMITER`: a global budget of **failed** code lookups (300/min). When it's exhausted, the isolate answers every code lookup with 429 for a minute, so guessing yields no signal. Successful lookups never count.
- No IP addresses or fingerprints are stored.

## Printing

PDFs are generated in the admin's browser from one consistent snapshot (`GET /api/admin/print/snapshot`, a single D1 batch read):

- Mosaic: A4 portrait, 2×3 cards, Newsreader text with Noto Emoji fallback, embedded fonts (vector text). Order is a seeded Fisher–Yates over notes sorted by id, then a de-clustering pass so the same teacher isn't within 6 positions where avoidable.
- Each note is fitted from 11 pt down to 8.5 pt. If it still doesn't fit, or contains characters no embedded font can draw, **no PDF is produced** and the note is listed with an "Edit print text" link (the original text stays).
- Measuring uses raw glyph advances, which match how pdf-lib draws. Emoji faces are embedded whole because pdf-lib's subsetter drops some emoji glyphs.
- Keepsakes: one A4 document per teacher; bulk export as a ZIP.

## Decisions and trade-offs

- **Single Worker, two hostnames.** Simplest deploy; segregation is enforced in code (tested), not by separate deployments.
- **Access policy "Everyone + D1 allowlist" by default.** Makes in-app invitations work immediately without an API token; optional group sync exists.
- **Client-side PDF.** Avoids Worker CPU limits for 150-page documents; fonts load lazily on the Print page only.
- **Polling, not websockets.** Overview 15 s, lists 20–30 s; enough for a handful of admins.
- **A voided submission still blocks its browser.** Voiding is meant for spam; letting the same browser resubmit would defeat it. Admins can see this in the docs and UI.
