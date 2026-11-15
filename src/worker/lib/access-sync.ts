import type { Env } from "../env";

export type SyncStatus = "not_configured" | "synced" | "failed";

/**
 * Optional: mirrors active D1 users into a Cloudflare Access group so the
 * Access policy can be "Include: Access group" instead of "Everyone".
 * Requires CF_API_TOKEN (Access: Organizations, Identity Providers, and Groups — Edit),
 * CF_ACCOUNT_ID and ACCESS_GROUP_ID. D1 remains the source of authorisation either way.
 */
export async function syncAccessGroup(env: Env): Promise<SyncStatus> {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID || !env.ACCESS_GROUP_ID) return "not_configured";
  const { results } = await env.DB.prepare("SELECT email FROM users WHERE active = 1 ORDER BY email").all<{ email: string }>();
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/access/groups/${env.ACCESS_GROUP_ID}`;
  const headers = { authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" };
  try {
    const cur = await fetch(base, { headers });
    if (!cur.ok) return "failed";
    const data = (await cur.json()) as { result?: { name?: string } };
    const res = await fetch(base, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        name: data.result?.name ?? "stjb-thanks-staff",
        include: results.map((r) => ({ email: { email: r.email } })),
      }),
    });
    return res.ok ? "synced" : "failed";
  } catch {
    return "failed";
  }
}
