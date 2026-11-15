import { useState } from "react";
import clsx from "clsx";
import { UserPlus } from "lucide-react";
import { fmtTime } from "../../lib/api";
import type { Me } from "../../../shared/types";
import { PageHeader, Select, patch, post, useAction } from "../common";
import { Banner, ConfirmDialog, Spinner } from "../../components/ui";
import { useUsers, type UserRow } from "./data";

export function UsersPage({ me }: { me: Me }) {
  const q = useUsers();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"reviewer" | "admin">("reviewer");
  const [confirm, setConfirm] = useState<{ u: UserRow; change: { role?: string; active?: boolean } } | null>(null);
  const invite = useAction((v: { email: string; role: string }) => post<{ accessSync: string }>("/api/admin/users", v), {
    invalidate: [["users"], ["assignments"]],
    success: (r) =>
      r.accessSync === "synced"
        ? "Invited and added to the Access group"
        : r.accessSync === "failed"
          ? "Invited, but the Access group update failed — check the Access policy"
          : "Invited. They can sign in with an email code now.",
    onSuccess: () => setEmail(""),
  });
  const update = useAction((v: { id: string; role?: string; active?: boolean }) => patch(`/api/admin/users/${v.id}`, v), {
    invalidate: [["users"], ["assignments"]],
    success: "Updated",
  });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Banner tone="bad">{(q.error as Error).message}</Banner>;
  const users = q.data.users;
  return (
    <div>
      <PageHeader
        title="People"
        lead="Reviewers and administrators sign in with a one-time code sent to their email by Cloudflare Access. This list decides what each person can do."
      />
      <form
        className="card mb-6 flex flex-wrap items-end gap-3 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          invite.mutate({ email, role });
        }}
      >
        <label className="flex min-w-[240px] flex-1 flex-col gap-1 text-[13px] font-medium text-ink-2">
          Email address
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@example.com"
            className="h-10 rounded-lg border border-line-strong bg-card px-3 text-sm text-ink focus:border-ink focus:outline-none"
          />
        </label>
        <Select label="Role" value={role} onChange={(e) => setRole(e.target.value as "reviewer" | "admin")}>
          <option value="reviewer">Reviewer — assigned notes only</option>
          <option value="admin">Administrator — full access</option>
        </Select>
        <button className="btn-primary btn-sm h-10" disabled={invite.isPending}>
          <UserPlus aria-hidden className="size-4" /> Invite
        </button>
      </form>
      {!q.data.accessSyncConfigured ? (
        <p className="mb-4 text-sm text-ink-2">
          Access group sync is off. Your Access policy must allow anyone who can receive an email code (see SETUP.md); this list is what grants access. Tell invitees to open the dashboard address and use the email shown here.
        </p>
      ) : null}
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-[12px] text-muted">
            <tr className="border-b border-line">
              <th className="px-4 py-2 font-medium">Person</th>
              <th className="px-3 py-2 font-medium">Role</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 text-right font-medium">Workload</th>
              <th className="px-3 py-2 font-medium">Last seen</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const self = u.id === me.id;
              const locked = self || (u.isOwner && !me.isOwner);
              return (
                <tr key={u.id} className={clsx("border-b border-line last:border-0", !u.active && "text-muted")}>
                  <td className="px-4 py-2.5">
                    <span className="font-medium">{u.email}</span>
                    {u.isOwner ? <span className="ml-2 chip bg-paper-2 text-ink-2">Owner</span> : null}
                    {self ? <span className="ml-2 chip bg-paper-2 text-ink-2">You</span> : null}
                    <p className="text-xs text-muted">{u.invitedBy ? `Invited by ${u.invitedBy}` : "Bootstrap owner"}</p>
                  </td>
                  <td className="px-3 py-2.5">
                    <select
                      aria-label={`Role for ${u.email}`}
                      disabled={locked || update.isPending}
                      value={u.role}
                      onChange={(e) => setConfirm({ u, change: { role: e.target.value } })}
                      className="h-8 rounded-md border border-line-strong bg-card px-2 text-sm disabled:opacity-60"
                    >
                      <option value="reviewer">Reviewer</option>
                      <option value="admin">Administrator</option>
                    </select>
                  </td>
                  <td className="px-3 py-2.5">{u.active ? <span className="chip bg-ok-soft text-ok">Active</span> : <span className="chip bg-paper-2 text-muted">Disabled</span>}</td>
                  <td className="px-3 py-2.5 text-right tabular">
                    {u.pending} pending / {u.assigned}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-ink-2">{u.lastSeenAt ? fmtTime(u.lastSeenAt) : "Never signed in"}</td>
                  <td className="px-4 py-2.5 text-right">
                    {!locked ? (
                      <button className="btn-ghost btn-sm" disabled={update.isPending} onClick={() => setConfirm({ u, change: { active: !u.active } })}>
                        {u.active ? "Disable" : "Enable"}
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(v) => !v && setConfirm(null)}
        title={
          confirm?.change.active === false
            ? `Disable ${confirm.u.email}?`
            : confirm?.change.active === true
              ? `Enable ${confirm.u.email}?`
              : `Make ${confirm?.u.email} ${confirm?.change.role === "admin" ? "an administrator" : "a reviewer"}?`
        }
        description={
          confirm?.change.active === false
            ? "They lose access on their next request. Their reviewed notes stay as they are; use Review workload to hand on their pending notes."
            : confirm?.change.role === "admin"
              ? "Administrators can see award results, class codes and every note, and can manage people."
              : "Changes take effect on their next request."
        }
        confirmLabel="Confirm"
        tone={confirm?.change.active === false ? "danger" : "primary"}
        onConfirm={() => {
          if (confirm) update.mutate({ id: confirm.u.id, ...confirm.change });
          setConfirm(null);
        }}
      />
    </div>
  );
}
