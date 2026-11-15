import { useInfiniteQuery } from "@tanstack/react-query";
import { api, fmtTime } from "../../lib/api";
import { Empty, PageHeader } from "../common";
import { Spinner } from "../../components/ui";

interface Entry {
  id: string;
  actor: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  detail: string;
  createdAt: string;
}

function summary(detail: string) {
  try {
    const d = JSON.parse(detail) as Record<string, unknown>;
    const s = JSON.stringify(d);
    return s === "{}" ? "" : s.length > 220 ? `${s.slice(0, 220)}…` : s;
  } catch {
    return "";
  }
}

export function AuditPage() {
  const q = useInfiniteQuery({
    queryKey: ["audit"],
    queryFn: ({ pageParam }) => api<{ items: Entry[]; nextCursor: string | null }>(`/api/admin/audit${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ""}`),
    initialPageParam: "",
    getNextPageParam: (l) => l.nextCursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div>
      <PageHeader title="Audit log" lead="Privileged changes: awards, classes and codes, quotas, people, voids and restores, settings and exports. Note-level history lives on each note." />
      {q.isPending ? (
        <Spinner />
      ) : items.length === 0 ? (
        <Empty title="Nothing logged yet" />
      ) : (
        <div className="card divide-y divide-line">
          {items.map((e) => (
            <div key={e.id} className="grid gap-1 px-4 py-3 text-sm sm:grid-cols-[180px_1fr]">
              <p className="text-muted">{fmtTime(e.createdAt)}</p>
              <div className="min-w-0">
                <p>
                  <span className="font-medium">{e.actor ?? "system"}</span> · <code className="text-[13px]">{e.action}</code>
                </p>
                {summary(e.detail) ? <p className="mt-0.5 break-all font-mono text-xs text-ink-2">{summary(e.detail)}</p> : null}
              </div>
            </div>
          ))}
        </div>
      )}
      {q.hasNextPage ? (
        <div className="mt-4 flex justify-center">
          <button className="btn-outline" onClick={() => void q.fetchNextPage()}>
            Load more
          </button>
        </div>
      ) : null}
    </div>
  );
}
