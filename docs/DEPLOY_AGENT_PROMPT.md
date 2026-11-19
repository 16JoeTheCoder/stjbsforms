# Backup prompt for an AI deployment agent

Only needed if Workers Builds isn't connected or a build fails. Paste the text below into an agent that has Wrangler access to the **STJB council** Cloudflare account (the one with team domain `stjbs-council.cloudflareaccess.com`).

---

Deploy the GitHub repo `16JoeTheCoder/stjbsforms` (branch `main`) to Cloudflare. Follow SETUP.md §H and stop to ask me before anything destructive.

1. Clone the repo, then run `npm ci`, `npm run check` and `npm run build`. Stop if any step fails and show me the error.
2. Run `npx wrangler whoami`. Confirm the account owns the D1 database id in `wrangler.jsonc` (`npx wrangler d1 list` should show `stjb-thanks-prod` with that id). If it doesn't, stop.
3. Run `npx wrangler d1 migrations list stjb-thanks-prod --remote`. Then apply the pending migrations: `npx wrangler d1 migrations apply stjb-thanks-prod --remote`. They are additive only. Never run seed files or `DELETE` against this database.
4. Run `npx wrangler secret list`. It must include `APP_SECRET`, `TURNSTILE_SECRET_KEY` and `OWNER_EMAIL`. If any is missing, ask me for the value. Never print, log or commit secrets.
5. Run `npx wrangler deploy`. Don't use `--env staging` and don't change `wrangler.jsonc`.
6. Smoke test:
   - `curl -s https://thanks.stjbscouncil.org/api/public/config` returns JSON.
   - `curl -s -o /dev/null -w "%{http_code}" https://thanks.stjbscouncil.org/api/admin/overview` returns `404`.
   - `curl -s -o /dev/null -w "%{http_code}" https://thanks-admin.stjbscouncil.org/api/admin/overview` returns `302` or `403`.
7. Report the deployed version id (`npx wrangler deployments list`), the migrations applied and the smoke-test results. If something broke, roll back with `npx wrangler rollback` and tell me.

Don't open or close student submissions, and don't touch DNS records other than the two `thanks*` subdomains or any other Worker.
