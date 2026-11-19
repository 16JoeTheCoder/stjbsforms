# Testing

| Command | What it runs | Where |
|---|---|---|
| `npm run typecheck` | TypeScript for client, Worker and Node tooling | Node |
| `npm run lint` | ESLint (TypeScript + React hooks) | Node |
| `npm run test:unit` | Shared rules, search, shuffle, PDF engine (`test/unit`) | Node |
| `npm run test:worker` | API integration tests against a real local D1 (`test/worker`) | workerd via `@cloudflare/vitest-plugin` |
| `npm run test:e2e` | Browser tests (`e2e/`), desktop Chrome + Pixel 7 | Playwright, own server on :8788 |
| `npm run test:load` | 300-student burst from one IP with duplicate retries | Node against a running local stack |
| `npm run check` | typecheck + lint + unit + worker + build | |

`npm test` = unit + worker.

## Coverage map

**Validation** (`test/worker/public.test.ts`, `test/unit/shared.test.ts`)
- Class codes: 5 characters, case-insensitive, ambiguous characters rejected, unknown/disabled/paused codes, rotated codes → `CODE_CHANGED`.
- Six distinct award teachers, complete ballot, three distinct recipients, award/letter overlap allowed.
- 99 / 100 / 400 / 401 graphemes; emoji and ZWJ families counted as one; whitespace-only and zero-width-only rejected.
- Identical letters after normalisation rejected; similar letters accepted; unknown teacher ids rejected; body size bound; cross-origin writes blocked.

**Submission reliability**
- Idempotent retry returns the same receipt; 5 concurrent identical requests → 1 row, 6 votes (worker test).
- Second submission from the same browser → `ALREADY_SUBMITTED`; receipt lookup.
- Over-quota submissions accepted and flagged; closed window / closing time; Turnstile enforced when configured.
- Browser (e2e): full flow and confirmation dialog; receipt survives reload; local data cleared → still blocked, with honest "not sent" copy; draft survives reload; **lost response** (server commits, browser connection reset) recovered without a duplicate; offline submit keeps all answers.

**Permissions** (`test/worker/auth.test.ts`)
- Valid Access JWT; missing / wrong audience / wrong issuer / expired / forged / malformed tokens; spoofed identity headers ignored.
- Staff APIs 404 on the public host, `*.workers.dev` and preview hostnames; dev shortcut disabled outside development.
- Reviewers forbidden on every admin endpoint; disabled users locked out immediately; CSRF; no CORS.
- Self-modification blocked, owner protected, last-admin guard; reviewer IDOR (unassigned / other reviewer's notes → 404) and no class fields in reviewer responses.

**Moderation** (`test/worker/moderation.test.ts`)
- Approve → trash → restore with complete event log; stale version → 409 with no write; two concurrent moderators → exactly one wins.
- Reviewer scope, restore policy, reassignment mid-review locks out the old reviewer; bulk skips no-ops.
- Void excludes votes and notes from results and print; double void → 409; restore brings back votes and keeps note states; audited.
- Distribute evenly (spread ≤ 1), assignments stable when new notes arrive, rebalance never moves reviewed notes.
- Rankings count active submissions only; renaming awards/teachers keeps data; coverage formula; council notes; print snapshot contents; CSV formula neutralisation.

**PDF** (`test/unit/pdf.test.ts`, `test/unit/emoji-render.test.ts`)
- 6 notes per A4 page, page count, every note exactly once, A4 dimensions.
- 400-character notes with paragraphs and a very long teacher name fit at ≥ 8.5 pt.
- Indonesian, accents, Vietnamese, emoji; unsupported scripts reported (no PDF, nothing dropped); oversize notes reported instead of clipped.
- Deterministic shuffle; no ids in output; multi-page keepsake.
- Rendering: every tested emoji leaves ink (via `pdftoppm`); word spaces survive kerning and font switches (via `pdftotext`). These two skip if poppler isn't installed.

**Teacher picker** (e2e)
- Honorific + typo search, ArrowUp/ArrowDown/Enter, Escape keeps the value, free text never becomes a selection, already-used teachers marked and unselectable, Next blocked until complete; touch via the Pixel 7 project.

## Results at time of handover

Measured in the development container on 2026-11-15:

- Unit: 27 passed. Worker integration: 63 passed (incl. AI review export/import). E2E: 18 passed, 4 skipped (admin flows aren't run at phone width; the mobile reviewer test skips when nothing is assigned).
- Load (`STUDENTS=300 CONCURRENCY=50`, one IP, 20% triple-click bursts): 436 submit requests → **300 submissions, 0 duplicate receipts, 0 rate-limited**, local p95 ≈ 0.6 s. This is the local Miniflare/D1 runtime on one machine, not a production benchmark. Production D1 serialises writes per database; at 300 students the expected write rate is far below its limits, but run the load script against **staging** (`BASE=https://thanks-staging...` needs Turnstile test keys) if you want hosted numbers.

## Running locally

```bash
npm run db:reset:local
```

```bash
npm run preview
```

```bash
BASE=http://localhost:8787 STUDENTS=300 CONCURRENCY=50 npm run test:load
```

Worker tests read `.dev.vars` if present, but the test config overrides every value they depend on, so they behave the same in CI.
