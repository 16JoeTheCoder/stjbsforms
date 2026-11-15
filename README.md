# STJB Teacher's Day — appreciation platform

Anonymous award voting and appreciation letters for St. Johannes Berchmans School, with a reviewer workflow, a full admin dashboard, and print-ready A4 PDFs for the appreciation wall.

- **Students** (`thanks.stjbscouncil.com`): enter a 5-character class code → pick a teacher for each of 6 awards → write 3 letters (100–400 characters) → review and submit. Progress is saved on the device; retries never create duplicates.
- **Reviewers** (`thanks-admin.stjbscouncil.com`, email one-time code via Cloudflare Access): a fast queue of their assigned notes with Approve / Trash / Restore and keyboard shortcuts.
- **Admins**: overview, Pinterest-style note board, trash, whole-submission void/restore, class codes and soft quotas, teachers and coverage, awards and rankings, review workload distribution, people, settings, audit log, CSV exports, A4 mosaic and per-teacher keepsake PDFs.

**Stack:** one Cloudflare Worker (Hono) + Workers Static Assets (React 19, Vite, Tailwind 4) + D1 + Turnstile + Cloudflare Access. No other services.

## Quick start (local)

```bash
npm install
```

```bash
cp .dev.vars.example .dev.vars
```

```bash
npm run db:reset:local
```

```bash
npm run dev
```

Open <http://localhost:5173> (student form; demo code `K7M4P`) and <http://localhost:5173/admin>.

## Documentation

- [SETUP.md](SETUP.md) — local setup, Cloudflare resources, domains, Access, secrets, GitHub → Cloudflare deployment, operations, troubleshooting
- [ARCHITECTURE.md](ARCHITECTURE.md) — design, data model, security model, reliability decisions
- [TESTING.md](TESTING.md) — test suites, coverage map, latest results
- [DESIGN.md](DESIGN.md) — visual system

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Worker API (:8787) + Vite (:5173) |
| `npm run build` | Production assets into `dist/client` |
| `npm run check` | typecheck, lint, unit + integration tests, build |
| `npm run test:e2e` | Playwright browser tests |
| `npm run test:load` | 300-student local load simulation |
| `npm run db:reset:local` | Fresh local D1 with demo data |
| `npm run db:migrate:prod` | Apply migrations to production D1 (run manually, see SETUP §H8) |

Deployment is handled by Cloudflare Workers Builds from the `main` branch. GitHub Actions only runs checks.
