"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { Send, RefreshCw, Loader2, Search, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDateTime } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { moveError, useMovedOut, useUndoMoveToCrm } from "@/hooks/useCrmLeadMoves";

/**
 * Moved leads (2026-11-19): every lead this CRM moved to the Sales, Draw or Remote CRM — where it went, who has it
 * there, who moved it — with Undo for 24 hours. Super Admins, the Sales Manager and team leaders (their teams').
 */
export default function MovedLeadsPage() {
  const [search, setSearch] = useState("");
  const { data, isLoading, isFetching, refetch, error } = useMovedOut(true);
  const undo = useUndoMoveToCrm();
  const notAllowed = (error as { response?: { status?: number } } | null)?.response?.status === 403;
  const q = search.trim().toLowerCase();
  const rows = useMemo(
    () => (data ?? []).filter((r) => !q || [r.name, r.phone, r.ownerName, r.toName, r.holder, r.byName].some((v) => String(v ?? "").toLowerCase().includes(q))),
    [data, q],
  );

  return (
    <div className="space-y-6">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Send className="h-6 w-6 text-primary" />
            <h2 className="text-2xl font-bold">Moved leads</h2>
          </div>
          <p className="text-muted-foreground text-sm mt-0.5">Leads moved from here to another CRM — Undo within 24 hours brings one back as it was</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, phone, person" className="h-9 w-56 pl-8" />
          </div>
          <Button variant="outline" size="icon" onClick={() => refetch()} aria-label="Refresh">
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </motion.div>

      {notAllowed ? (
        <p className="text-sm text-muted-foreground">Moved leads are for Super Admins, the Sales Manager and team leaders.</p>
      ) : isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>
      ) : error ? (
        <p className="text-sm text-destructive">{moveError(error, "Could not load moved leads")}</p>
      ) : !rows.length ? (
        <p className="text-sm text-muted-foreground">{q ? "Nothing matches." : "No leads moved to another CRM yet."}</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border/60">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 text-left">Lead</th>
                <th className="px-4 py-2.5 text-left">Was</th>
                <th className="px-4 py-2.5 text-left">Moved to</th>
                <th className="px-4 py-2.5 text-left">By</th>
                <th className="px-4 py-2.5 text-right"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {rows.map((r) => (
                <tr key={r.id} className={r.undoneAt ? "opacity-60" : ""}>
                  <td className="px-4 py-2.5">
                    <Link href={`/leads/${r.id}`} className="font-medium hover:underline">{r.name || "—"}</Link>
                    <div className="text-xs text-muted-foreground">{r.phone}</div>
                  </td>
                  <td className="px-4 py-2.5">
                    <div>{r.ownerName || "Nobody"}</div>
                    <div className="text-xs capitalize text-muted-foreground">{r.status.replace(/_/g, " ")}</div>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="font-medium">{r.toName}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.outcome === "repeat" ? `Already there — its team leader${r.holder ? ` (${r.holder})` : ""}` : r.holder ? `→ ${r.holder}` : "→ their split"}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <div>{r.byName || "—"}</div>
                    <div className="text-xs text-muted-foreground">{formatDateTime(r.at)}</div>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {r.undoneAt ? (
                      <span className="text-xs text-muted-foreground">Undone</span>
                    ) : r.canUndo ? (
                      <Button size="sm" variant="outline" disabled={undo.isPending && undo.variables === r.id}
                        onClick={() => undo.mutate(r.id, {
                          onSuccess: () => toast.success(`${r.name || "The lead"} is back here`),
                          onError: (e) => toast.error(moveError(e, "Not undone")),
                        })}>
                        {undo.isPending && undo.variables === r.id ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Undo2 className="mr-1.5 h-3.5 w-3.5" />}
                        Undo
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
