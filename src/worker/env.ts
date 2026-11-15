export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  /** Per-browser limiter (keyed by the HttpOnly browser id) */
  BROWSER_LIMITER?: RateLimit;
  /** Generous per-network backstop: a whole school shares one IP, so keep this high */
  NETWORK_LIMITER?: RateLimit;

  /** "production" | "staging" | "development". Dev-only shortcuts require "development". */
  ENVIRONMENT: string;
  /** Hostname of the student portal, e.g. thanks.stjbscouncil.com */
  PUBLIC_HOST: string;
  /** Hostname of the staff portal, e.g. thanks-admin.stjbscouncil.com */
  ADMIN_HOST: string;
  /** https://<team>.cloudflareaccess.com */
  ACCESS_TEAM_DOMAIN: string;
  /** Access application AUD tag for the staff hostname */
  ACCESS_AUD: string;
  /** First administrator, auto-provisioned on first verified login */
  OWNER_EMAIL: string;
  TURNSTILE_SITE_KEY: string;

  // Secrets
  TURNSTILE_SECRET_KEY?: string;
  /** Random 32+ byte secret for HMAC of class codes / browser ids and code encryption */
  APP_SECRET?: string;
  /** Optional: scoped token to keep an Access group in sync with D1 users */
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  ACCESS_GROUP_ID?: string;

  /** development only: default identity when no Access JWT is present */
  DEV_USER_EMAIL?: string;
}
