# Setup guide

Step-by-step setup for the STJB Teacher's Day platform. Written for a technically capable student who hasn't run Cloudflare infrastructure before. Follow the sections in order the first time.

> **Golden rules**
> - Never paste API tokens, secrets or D1 credentials into code, commits, chats or browser code. Secrets go in `wrangler secret put` or the Cloudflare dashboard only.
> - Never run test data (`db:seed:local`) against staging or production.
> - Don't touch the existing `stjbscouncil.org` website, its DNS records, or other Workers. This app only adds two **new** subdomains.

Placeholders look like `<LIKE_THIS>`. Replace them with your own values.

---

## A. Prerequisites

| Tool | Version | Check |
|---|---|---|
| Node.js | 22 or newer | `node -v` |
| npm | 10 or newer (comes with Node) | `npm -v` |
| Git | any recent | `git --version` |
| GitHub CLI (optional) | any | `gh --version` |
| Wrangler | installed per-project by `npm install`; run as `npx wrangler` | `npx wrangler --version` |

Accounts and permissions:

- A **Cloudflare account** that owns the `stjbscouncil.org` zone (it's registered through Cloudflare Registrar, so it already is).
- Permission on that account to manage **Workers & Pages**, **D1**, **Turnstile**, and **Zero Trust (Access)**. The account owner has all of these.
- Read access to the private GitHub repository.
- Sign Wrangler in once: `npx wrangler login` (opens a browser). Check with `npx wrangler whoami`.

---

## B. Local setup

```bash
git clone https://github.com/16JoeTheCoder/stjbsforms.git
```

```bash
cd stjbsforms
```

```bash
npm install
```

Create your local settings file (gitignored) from the example:

```bash
cp .dev.vars.example .dev.vars
```

Create the local database, apply migrations and load **demo** data (fake teachers, classes with known codes, demo staff):

```bash
npm run db:reset:local
```

The command prints the demo class codes (for example `Secondary 1A=K7M4P`) and staff emails.

Start the app. This runs the Worker API on `http://localhost:8787` and the Vite dev server on `http://localhost:5173` (which forwards `/api` to the Worker):

```bash
npm run dev
```

- Student form: <http://localhost:5173/>
- Admin dashboard: <http://localhost:5173/admin> (you're signed in as `DEV_USER_EMAIL` from `.dev.vars`, normally `owner@example.com`)
- Reviewer view: <http://localhost:5173/review> — to act as a reviewer locally, set `DEV_USER_EMAIL=reviewer1@example.com` in `.dev.vars` and restart `npm run dev:api`.

The local identity shortcut works **only** when `ENVIRONMENT=development` **and** the request is to `localhost`. Production ignores it (tested in `test/worker/auth.test.ts`).

Tests and builds:

```bash
npm run typecheck
```

```bash
npm run lint
```

```bash
npm test
```

```bash
npm run build
```

```bash
npm run test:e2e
```

`npm run test:e2e` starts its own throwaway server on port 8788. If Playwright browsers aren't installed on your machine, run `npx playwright install chromium` once. See [TESTING.md](TESTING.md) for everything else.

To preview the production build locally on one port (no Vite): `npm run preview`, then open <http://localhost:8787>.

---

## C. Cloudflare resources

Do these once. Use the **staging** resources to rehearse before touching production.

### C1. D1 databases

```bash
npx wrangler d1 create stjb-thanks-prod
```

```bash
npx wrangler d1 create stjb-thanks-staging
```

Each command prints a `database_id`. Put them into `wrangler.jsonc`:

- top-level `d1_databases[0].database_id` ← the **prod** id
- `env.staging.d1_databases[0].database_id` ← the **staging** id

Database IDs aren't secret; commit them.

Apply the schema (creates tables, the six awards and the grade levels):

```bash
npx wrangler d1 migrations apply stjb-thanks-staging --remote --env staging
```

```bash
npx wrangler d1 migrations apply stjb-thanks-prod --remote
```

Expected: a table listing `0001_init.sql` and `0002_integrity.sql` with ✅.

### C2. Worker and Static Assets

There's nothing to create by hand. The Worker `stjb-thanks` (name from `wrangler.jsonc`) is created on first deploy (section H). The React app is built into `dist/client` and served by **Workers Static Assets** from the same Worker; `/api/*` always runs the Worker first (`assets.run_worker_first`). Unknown paths fall back to `index.html` (single-page app).

### C3. Turnstile widget

1. Cloudflare dashboard → **Turnstile** → **Add widget**.
2. Name: `STJB Thanks`. Hostnames: `thanks.stjbscouncil.org` (add `thanks-staging.stjbscouncil.org` for staging, or create a second widget).
3. Widget mode: **Managed**.
4. Copy the **Site key** (public) into `wrangler.jsonc` → `vars.TURNSTILE_SITE_KEY`.
5. Store the **Secret key** as a Worker secret (after the Worker exists, or right away — Wrangler creates it if needed):

```bash
npx wrangler secret put TURNSTILE_SECRET_KEY
```

The server checks the token with Cloudflare's Siteverify API and requires `action = "submit"` and `hostname = PUBLIC_HOST`. For staging you may use Cloudflare's test keys (site `1x00000000000000000000AA`, secret `1x0000000000000000000000000000000AA`); test keys are refused in production.

### C4. Cloudflare Access (staff sign-in with email codes)

Access puts a login screen in front of the staff hostname. Staff type their email, get a one-time code, and are in. The app then checks the D1 `users` table for their role.

1. Dashboard → **Zero Trust**. If asked, pick a team name (e.g. `stjb`). Your team domain becomes `https://<TEAM>.cloudflareaccess.com`.
2. **Settings → Authentication → Login methods → Add new → One-time PIN.** (No Google login is needed or used.)
3. **Access → Applications → Add an application → Self-hosted.**
   - Application name: `STJB Thanks staff`
   - Session duration: **1 week** (or the closest option offered). This is the "stay signed in" period.
   - Public hostname: subdomain `thanks-admin`, domain `stjbscouncil.org`, path empty (protects the whole hostname, including the dashboard's static files).
   - Identity providers: **One-time PIN** only. Turn on "Instant auth" if offered, so users skip the provider picker.
4. **Policy** — choose one design:
   - **Option A (recommended, simplest): "Verified email, app decides."** Policy name `Any verified email`, Action **Allow**, Include → **Everyone**. Anyone who can receive an email code can reach the login-protected shell, but **every API call is refused** unless that email is an active user in D1. Invitations in the app take effect immediately; nothing to sync.
   - **Option B: Access group kept in sync by the app.** Create an Access **group** (e.g. `stjb-thanks-staff`) with any one email, then Policy Include → that group. Create an API token with **Access: Organizations, Identity Providers, and Groups — Edit** for this account only, and set secrets `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `ACCESS_GROUP_ID`. The People page then reports "added to the Access group" or a failure — it never claims success if the sync failed.
5. Save. Open the application's **Overview/Basic information** and copy the **Application Audience (AUD) Tag**.
6. Put into `wrangler.jsonc` → `vars`:
   - `ACCESS_TEAM_DOMAIN`: `https://<TEAM>.cloudflareaccess.com`
   - `ACCESS_AUD`: the AUD tag

The Worker validates the `Cf-Access-Jwt-Assertion` header on every privileged request (signature via your team's public keys, issuer, audience, expiry). It never trusts emails from the browser or from unverified headers. (Cloudflare's `ctx.access` helper isn't used because Workers with Static Assets don't receive it.)

Repeat 3–6 for staging with hostname `thanks-admin-staging` and put its AUD into `env.staging.vars`.

---

## D. Custom domains

Target:

- `thanks.stjbscouncil.org` → student portal
- `thanks-admin.stjbscouncil.org` → staff portal (behind Access)

Both point at the same Worker. The Worker decides what each hostname may do: staff APIs answer **only** on `ADMIN_HOST` and **only** with a valid Access token; everywhere else they return 404.

1. In `wrangler.jsonc`, uncomment the `routes` block:

   ```jsonc
   "routes": [
     { "pattern": "thanks.stjbscouncil.org", "custom_domain": true },
     { "pattern": "thanks-admin.stjbscouncil.org", "custom_domain": true }
   ],
   ```

2. Commit and deploy (section H). Cloudflare creates the DNS records and TLS certificates for these two subdomains automatically. Existing records for `stjbscouncil.org`, `www` or anything else are untouched. Before deploying, check DNS for existing `thanks` or `thanks-admin` records; if one exists, Cloudflare won't attach the custom domain until you deliberately remove or rename it.
3. Create the Access application (C4) **before** announcing the staff URL.

**No unprotected side doors:**

- `workers_dev: false` disables `stjb-thanks.<account>.workers.dev`.
- `preview_urls: false` disables per-version preview URLs.
- Even if either were re-enabled, staff APIs refuse any hostname other than `ADMIN_HOST` and any request without a valid Access JWT for your AUD.
- In Workers Builds, turn **off** "Builds for non-production branches" (section H) so branches don't create previews.

Verify after deploy:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://thanks.stjbscouncil.org/api/admin/overview
```

Expected `404`.

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://thanks-admin.stjbscouncil.org/api/admin/overview
```

Expected `302` or `403` (redirect to the Access login — you aren't signed in from curl).

---

## E. Admin and reviewer setup

### Bootstrap the first owner

Set the owner's email as a secret (keeps a personal address out of the repo):

```bash
npx wrangler secret put OWNER_EMAIL
```

Then open `https://thanks-admin.stjbscouncil.org`, enter that email, enter the code from your inbox. On this first verified login the app creates you as the **owner** administrator. (Placeholder addresses like `@example.com` are never bootstrapped outside development.)

Manual alternative (if you prefer SQL):

```bash
npx wrangler d1 execute stjb-thanks-prod --remote --command "INSERT INTO users (id,email,role,active,is_owner,access_sync,created_at,updated_at) VALUES ('usr_owner','<YOUR_EMAIL>','admin',1,1,'manual',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
```

### Invite reviewers and admins

Dashboard → **People** → enter email → choose **Reviewer** or **Administrator** → **Invite**. Then send them the staff link. They sign in with an email code — no password.

- With Access Option A they can sign in immediately.
- With Option B the page tells you whether the Access group update succeeded.

### Revoke access

People → **Disable**. Their next request is refused (the app re-checks D1 on every request), their **pending** notes go back to the unassigned queue, and their reviewed notes keep their history. You can't disable or demote yourself, only the owner can change the owner, and the last active admin can't be removed.

To also end their Access session immediately: Zero Trust → **My Team → Users** → select the user → **Revoke session**.

### Session length and sign-out

- Session length = the Access application's session duration (C4, 1 week).
- **Sign out** in the dashboard goes to `/cdn-cgi/access/logout`, which ends the Access session on that device.

### Email codes not arriving

1. Check spam/junk and "Promotions". The sender is Cloudflare Access (`noreply@notify.cloudflare.com`).
2. School mail servers sometimes delay or quarantine external mail — ask IT to allow that sender, or use a personal address.
3. Codes expire after a few minutes; request a new one.
4. Confirm **One-time PIN** is enabled as a login method and attached to the application (C4 steps 2–3).
5. With Option B, confirm the email is in the Access group.
6. Zero Trust → **Logs → Access** shows each login attempt and why it was denied.

---

## F. Initial data

The migrations already create:

- the six award categories (rename or reorder them in **Awards**), and
- grade levels Sec 1–4, JC1, JC2 (new grades are created automatically by class import).

### Teachers (41)

Dashboard → **Teachers & coverage** → **Import CSV**. Template: [`docs/templates/teachers.csv`](docs/templates/teachers.csv)

```csv
honorific,full_name
Ms.,Catherine Tan
Mr.,Budi Santoso
```

Re-importing updates names for existing teachers (matched by name, ignoring titles); it never duplicates or reactivates anyone.

### Classes, grades and expected counts

Dashboard → **Classes** → **Import CSV**. Template: [`docs/templates/classes.csv`](docs/templates/classes.csv)

```csv
class,grade,expected_students,soft_quota
Secondary 1A,Sec 1,25,30
Junior College 2A,JC2,22,
```

Leave `soft_quota` empty to use expected + 5 (Settings → "Default quota buffer"). New classes get a random 5-character code, shown once in the import result. Codes can be re-displayed later with **Show** (logged) or exported with **Export with codes**. Distribute codes to class representatives privately.

### Open the form

Settings → **Open submissions** (optionally set opening/closing times, in Jakarta time). Do this only after the production smoke test (H11).

---

## G. Environment variables and secrets

| Name | Purpose | Public / secret | Where it's set | Example placeholder |
|---|---|---|---|---|
| `ENVIRONMENT` | `production`, `staging` or `development` (dev shortcuts need exactly `development`) | public | `wrangler.jsonc` vars; `.dev.vars` locally | `production` |
| `PUBLIC_HOST` | Student hostname (Turnstile hostname check) | public | `wrangler.jsonc` vars | `thanks.stjbscouncil.org` |
| `ADMIN_HOST` | Staff hostname (only host where staff APIs answer) | public | `wrangler.jsonc` vars | `thanks-admin.stjbscouncil.org` |
| `ACCESS_TEAM_DOMAIN` | Access issuer / key URL | public | `wrangler.jsonc` vars | `https://<TEAM>.cloudflareaccess.com` |
| `ACCESS_AUD` | Access application AUD tag | public | `wrangler.jsonc` vars | `<64-hex-chars>` |
| `TURNSTILE_SITE_KEY` | Turnstile widget key sent to browsers | public | `wrangler.jsonc` vars | `0x4AAAAAAA...` |
| `OWNER_EMAIL` | First admin, created on first verified login | secret (personal data) | `wrangler secret put OWNER_EMAIL` | `<you@example.org>` |
| `APP_SECRET` | 32+ random characters; HMAC for class codes and browser ids, encryption of displayable codes | **secret** | `wrangler secret put APP_SECRET` | output of `openssl rand -base64 48` |
| `TURNSTILE_SECRET_KEY` | Siteverify secret | **secret** | `wrangler secret put TURNSTILE_SECRET_KEY` | `0x4AAAAAAA...` |
| `CF_API_TOKEN` | Optional, Access-group sync (Option B) only; scoped token | **secret** | `wrangler secret put CF_API_TOKEN` | `<token>` |
| `CF_ACCOUNT_ID` | Optional, Option B | secret-ish | `wrangler secret put CF_ACCOUNT_ID` | `<account id>` |
| `ACCESS_GROUP_ID` | Optional, Option B | secret-ish | `wrangler secret put ACCESS_GROUP_ID` | `<group uuid>` |
| `DEV_USER_EMAIL` | Local identity on localhost in development only | local only | `.dev.vars` | `owner@example.com` |

Generate and store `APP_SECRET` (do this once per environment, and keep it — changing it invalidates all class codes and browser ids):

```bash
openssl rand -base64 48
```

```bash
npx wrangler secret put APP_SECRET
```

For staging add `--env staging` to every `secret put`. Values in `wrangler.jsonc` `vars` are re-applied on every deploy, so edit them in the repo, not in the dashboard. No Cloudflare API token or D1 credential is ever used by browser code.

---

## H. GitHub → Cloudflare deployment

1. **Finish and push the private GitHub repository** (already done for this project; fill in the `REPLACE…` values and database ids in `wrangler.jsonc` first and commit them).
2. Cloudflare dashboard → **Workers & Pages**.
3. **Create application → Import a repository → GitHub**, authorise the Cloudflare GitHub app for this repository, and select it. *If a Worker named `stjb-thanks` already exists*, don't create another: open it → **Settings → Builds → Connect** instead. The Worker name must equal `name` in `wrangler.jsonc` or builds fail. (A Cloudflare agent you've authorised can perform the same steps.)
4. **Build command:** `npm run build`
5. **Deploy command:** `npx wrangler deploy`
   Root directory: `/`. Production branch: `main`. Turn **off** builds for non-production branches.
6. **Bind production D1:** nothing to click — the binding comes from `wrangler.jsonc` (`DB` → `stjb-thanks-prod`). Confirm the id there is the prod id.
7. **Add secrets** (Worker → Settings → Variables and Secrets, type *Secret*, or with `wrangler secret put`): `APP_SECRET`, `TURNSTILE_SECRET_KEY`, `OWNER_EMAIL` (+ Option B secrets).
8. **Apply migrations safely** from your laptop *before* the first deploy and before any deploy that adds a migration:

   ```bash
   npx wrangler d1 migrations list stjb-thanks-prod --remote
   ```

   ```bash
   npx wrangler d1 migrations apply stjb-thanks-prod --remote
   ```

   Migrations only ever add; Wrangler captures a backup before applying. Don't put migrations in the automatic deploy command.
9. **Configure Access and Turnstile** (C3, C4) if not done.
10. **Attach custom domains** (D). Push to `main` to trigger the build.
11. **Production smoke test:**
    - `https://thanks.stjbscouncil.org` loads the class-code screen.
    - `curl https://thanks.stjbscouncil.org/api/public/form` returns 41 teachers and 6 awards, and no vote data.
    - Staff URL asks for your email; after the code you see the Overview. The System panel shows environment `production` and Turnstile `configured`, with no warnings.
    - Create a throwaway class, open submissions, submit one response from your phone, check it appears, then **void** it (Submissions) and disable the throwaway class.
12. **Enable the student form only after the smoke test passes:** Settings → Open submissions.

GitHub Actions (`.github/workflows/ci.yml`) only runs checks; it never deploys, so it can't fight Workers Builds over the same Worker.

---

## I. Operations

| Task | How |
|---|---|
| Open / close submissions | Settings → Open/Close submissions, or schedule opening/closing times (Jakarta time). Students keep their drafts while closed. |
| Monitor errors | Worker → **Observability → Logs** (enabled in `wrangler.jsonc`). Note bodies, class codes and tokens are never logged. Live tail: `npx wrangler tail stjb-thanks` |
| Class participation | Overview (refreshes every 15 s) and Classes. Over-quota classes show "32 submissions / 30 recommended maximum". |
| Rotate a class code | Classes → **Rotate**. The old code stops working; students with drafts are asked for the new one and keep their answers. |
| Review workload | Review workload → select reviewers → **Distribute evenly**; **Rebalance pending** later; **Release pending** for someone who's away. |
| Export notes | Print & export → build the A4 mosaic or keepsakes (preview first, then download). CSVs: Settings → Exports. |
| Back up D1 | See schedule below. |
| Restore data | Point-in-time with D1 Time Travel (7 days on the Free plan, 30 days on Paid): `npx wrangler d1 time-travel info stjb-thanks-prod` then `npx wrangler d1 time-travel restore stjb-thanks-prod --timestamp=<ISO-TIME>`. From a SQL export: create a new database and `npx wrangler d1 execute <NEW_DB> --remote --file=backup.sql`, then switch the binding. |
| Deploy an update | Merge to `main`; Workers Builds deploys. Apply any new migration first (H8). |
| Roll back | Worker → **Deployments** → pick the previous version → **Rollback**, or `npx wrangler rollback`. Rollbacks don't undo database migrations, which is why migrations are additive only. |
| Migration failure | Wrangler rolls back the failed migration and keeps the previous ones. Read the error, fix the SQL in a **new** migration file (never edit an applied one), run `migrations apply` again. |

**Automatic backups (cloud).** The Worker has cron triggers that dump every D1 table to the private R2 bucket `stjb-thanks-backups` (binding `BACKUPS`, code in `src/worker/backup.ts`). Times in WIB: 14:00, 14:30, 14:40, 14:50, 15:00, 15:30, 16:00, 18:00 (cron is UTC: `0 7,8,9,11`, `30 7,8`, `40 7`, `50 7`). Files are `backups/YYYY-MM-DD/stjb-thanks-<date>_<HHMM>-WIB.json`. Create the bucket once with `npx wrangler r2 bucket create stjb-thanks-backups`; the schedule starts after the next `npx wrangler deploy`. List files in the Cloudflare dashboard under R2, or `npx wrangler r2 object get stjb-thanks-backups/<key> --remote --file=out.json`. Set a retention rule under the bucket's Settings, Object lifecycle rules.

**Backup schedule** (Time Travel alone isn't an archive):

- Daily while submissions are open, and after each review session:

  ```bash
  npx wrangler d1 export stjb-thanks-prod --remote --output=backups/stjb-$(date +%F).sql
  ```

- Before every migration, and right before printing.
- Also download Settings → **Full backup (JSON)** after the event.
- Store backups privately (not in the repo — `backups/` should stay outside git). Delete them under the council's retention policy after the event.

---

## J. Troubleshooting

| Symptom | Likely cause | Check / fix |
|---|---|---|
| `D1_ERROR: no such table` / every API 500s | Migrations not applied to that database, or wrong `database_id` | `npx wrangler d1 migrations list stjb-thanks-prod --remote`; compare the id in `wrangler.jsonc` with `npx wrangler d1 list` |
| API returns `503 CONFIG ... APP_SECRET` | Secret missing | `npx wrangler secret list` should show `APP_SECRET`, `TURNSTILE_SECRET_KEY`, `OWNER_EMAIL` |
| API returns `503 ... rate limiter` | `ratelimits` bindings missing from config | Restore the `ratelimits` block in `wrangler.jsonc` and redeploy |
| Access email code never arrives | Mail filtering / OTP not enabled | Section E "Email codes not arriving"; Zero Trust → Logs → Access |
| Signed in but "This email address does not have access" | Email not in People, or disabled | Ask an admin to invite/enable it. For the very first login, `OWNER_EMAIL` must match exactly. |
| Staff page says "Please sign in again" in a loop | `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN` don't match the Access app | Copy the AUD tag again (C4 step 5); team domain must start with `https://` and have no trailing slash issues |
| Staff APIs 404 on the admin URL | `ADMIN_HOST` doesn't match the real hostname | Fix `vars.ADMIN_HOST` and redeploy |
| "The verification check expired or failed" for every student | Wrong Turnstile secret, or hostname not on the widget | Turnstile → widget → Hostnames must include `PUBLIC_HOST`; re-put `TURNSTILE_SECRET_KEY` |
| Turnstile box never appears | `TURNSTILE_SITE_KEY` still `REPLACE…`, or an extension blocks `challenges.cloudflare.com` | Fix the var and redeploy; try another browser |
| Build fails in Workers Builds: name mismatch | Dashboard Worker name ≠ `name` in `wrangler.jsonc` | Rename one so they match |
| Build fails: `npm ci` / lockfile | Lockfile out of sync | Run `npm install` locally, commit `package-lock.json` |
| GitHub repo not listed in Cloudflare | Cloudflare GitHub app lacks access | GitHub → Settings → Applications → Cloudflare Workers and Pages → grant this repo |
| Custom domain shows the old site / 522 | A conflicting DNS record or route | DNS → check for existing `thanks` / `thanks-admin` records; Worker → Settings → Domains & Routes |
| Students see "Couldn't load the form" | API down or blocked | Open `/api/public/config` directly; check Worker logs |
| Teacher list is empty | Teachers not imported or all inactive | Teachers & coverage page; import the CSV |
| Submission fails with "Class code needed" | Code rotated or class disabled | Give students the current code (Classes → Show) |
| PDF build reports "characters the print font can't show" | Scripts outside Latin/Vietnamese/emoji (e.g. Chinese) | Click **Edit print text** next to the note and replace or transliterate; the original stays stored |
| PDF build reports "doesn't fit" | Dozens of line breaks in one note | Edit print text to join lines |

Useful commands:

```bash
npx wrangler whoami
```

```bash
npx wrangler d1 list
```

```bash
npx wrangler d1 execute stjb-thanks-prod --remote --command "SELECT COUNT(*) AS submissions FROM submissions"
```

```bash
npx wrangler deployments list
```

```bash
npx wrangler tail stjb-thanks
```
