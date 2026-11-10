"use client";
import { useDeferredValue, useMemo, useState } from "react";
import { ArrowRight, Loader2, Search, Undo2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "@/lib/toast";
import { useUsers } from "@/hooks/useUsers";
import {
  transferError, useTransferLeads, useTransferPreview, useTransferSummary, useUndoTransfer,
  type TransferDone, type TransferTarget,
} from "@/hooks/useLeadTransfer";

/*
 * Transfer a person's open leads (2026-11-10): to one person, or split between several — evenly, or the counts typed.
 * The preview says who gets how many and the team each lead lands in (the new owner's). Closed and lost leads stay
 * with them. Used by "Transfer leads" on the Users page, and by Delete before someone holding leads can go.
 */

interface Props {
  userId: string;
  userName: string;
  reason?: "transfer" | "remove";
  /** After the leads moved (or there were none to move). */
  onDone?: (result: TransferDone | null) => void;
}

const field = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

export function TransferLeadsPanel({ userId, userName, reason = "transfer", onDone }: Props) {
  const summary = useTransferSummary(userId);
  const { data: usersData } = useUsers({ status: "active", limit: "100" });
  const people = useMemo(
    () => (usersData?.data ?? []).filter((u) => u._id !== userId && u.status === "active").sort((a, b) => a.name.localeCompare(b.name)),
    [usersData, userId],
  );
  const [mode, setMode] = useState<"one" | "split">("one");
  const [one, setOne] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [ownCounts, setOwnCounts] = useState(false);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [done, setDone] = useState<TransferDone | null>(null);
  const transfer = useTransferLeads();
  const undo = useUndoTransfer();

  const targets: TransferTarget[] = mode === "one"
    ? (one ? [{ userId: one }] : [])
    : picked.map((id) => ({ userId: id, count: ownCounts ? (counts[id] === undefined || counts[id] === "" ? 0 : Number(counts[id])) : null }));
  const deferred = useDeferredValue(targets);
  const open = summary.data?.open ?? 0;
  // Everything else they hold — closed, lost (and in the Banglore CRM, booked) — stays with them.
  const kept = Object.values(summary.data?.byStatus ?? {}).reduce((x, n) => x + n, 0) - open;
  const preview = useTransferPreview(userId, deferred, open > 0 && !done);
  const typedTotal = ownCounts ? picked.reduce((a, id) => a + (Number(counts[id]) || 0), 0) : open;

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const shown = people.filter((u) => !search.trim() || u.name.toLowerCase().includes(search.trim().toLowerCase()));

  const go = () => {
    transfer.mutate({ userId, targets, reason }, {
      onSuccess: (r) => {
        setDone(r);
        toast.success(`${r.moved} lead${r.moved === 1 ? "" : "s"} transferred`);
        onDone?.(r);
      },
      onError: (e) => toast.error(transferError(e, "Not transferred")),
    });
  };

  if (summary.isLoading) return <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading their leads…</p>;
  if (summary.isError) return <p className="py-4 text-sm text-destructive">{transferError(summary.error, "Could not load their leads")}</p>;

  if (done) {
    return (
      <div className="space-y-3 text-sm">
        <p className="font-medium">Moved {done.moved} of {userName}&apos;s leads:</p>
        <ul className="space-y-1">
          {done.targets.filter((t) => t.count > 0).map((t) => (
            <li key={t.userId} className="flex items-center gap-2"><ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />{t.name} — {t.count}{t.team ? <span className="text-muted-foreground"> · {t.team}</span> : null}</li>
          ))}
        </ul>
        <Button variant="outline" size="sm" disabled={undo.isPending || undo.isSuccess}
          onClick={() => undo.mutate(done.id, {
            onSuccess: (u) => toast.success(`Undone: ${u.undone} back to ${userName}${u.skipped ? ` (${u.skipped} already worked, kept)` : ""}`),
            onError: (e) => toast.error(transferError(e, "Not undone")),
          })}>
          {undo.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Undo2 className="mr-2 h-4 w-4" />}
          {undo.isSuccess ? "Undone" : "Undo"}
        </Button>
        <p className="text-xs text-muted-foreground">Undo stays open for 24 hours (Users → Recent transfers), for leads nobody has worked since.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 text-sm">
      <p>
        <strong>{userName}</strong> holds <strong>{open}</strong> open lead{open === 1 ? "" : "s"}.
        {kept > 0 ? <span className="text-muted-foreground"> Their other {kept} (closed, lost…) stay with them.</span> : null}
      </p>
      {open === 0 ? (
        <p className="text-muted-foreground">No open leads to move.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Button type="button" variant={mode === "one" ? "default" : "outline"} size="sm" onClick={() => setMode("one")}>To one person</Button>
            <Button type="button" variant={mode === "split" ? "default" : "outline"} size="sm" onClick={() => setMode("split")}><Users className="mr-1.5 h-4 w-4" />Split</Button>
          </div>

          {mode === "one" ? (
            <select value={one} onChange={(e) => setOne(e.target.value)} className={field} aria-label="Give them to">
              <option value="">Give them to…</option>
              {people.map((u) => <option key={u._id} value={u._id}>{u.name}</option>)}
            </select>
          ) : (
            <div className="space-y-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find people" className="h-9 pl-8" />
              </div>
              <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
                {shown.map((u) => (
                  <label key={u._id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-muted/50">
                    <Checkbox checked={picked.includes(u._id)} onCheckedChange={() => toggle(u._id)} />
                    <span className="flex-1">{u.name}</span>
                    {ownCounts && picked.includes(u._id) && (
                      <Input type="number" min={0} value={counts[u._id] ?? ""} onClick={(e) => e.preventDefault()}
                        onChange={(e) => setCounts((c) => ({ ...c, [u._id]: e.target.value }))} className="h-7 w-20 text-right" aria-label={`Leads for ${u.name}`} />
                    )}
                  </label>
                ))}
                {!shown.length && <p className="px-1 py-2 text-muted-foreground">Nobody matches.</p>}
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Checkbox checked={ownCounts} onCheckedChange={(v) => setOwnCounts(v === true)} />
                Set how many each gets (otherwise evenly)
                {ownCounts && <span className={typedTotal === open ? "text-emerald-600" : "text-destructive"}>— {typedTotal} of {open}</span>}
              </label>
            </div>
          )}

          {targets.length > 0 && (
            <div className="rounded-md border p-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Who gets them</p>
              {preview.isLoading ? (
                <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Working it out…</p>
              ) : preview.isError ? (
                <p className="text-destructive">{transferError(preview.error, "Can't work it out")}</p>
              ) : preview.data ? (
                <ul className="space-y-1">
                  {preview.data.targets.map((t) => (
                    <li key={t.userId} className="flex items-center gap-2">
                      <span className="flex-1">{t.name}</span>
                      <span className="tabular-nums">{t.count} lead{t.count === 1 ? "" : "s"}</span>
                      <span className="w-40 truncate text-right text-xs text-muted-foreground">{t.team ? `→ ${t.team.name}` : "keeps the lead's team"}</span>
                    </li>
                  ))}
                  {preview.data.warnings.map((w) => <li key={w} className="text-xs text-amber-600">{w}</li>)}
                </ul>
              ) : null}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Each lead moves to its new owner&apos;s team and arrives as a new lead for them; their open reminders go with it.
          </p>
          <Button className="w-full" disabled={!preview.data || preview.isError || transfer.isPending || preview.isFetching} onClick={go}>
            {transfer.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Transfer {open} lead{open === 1 ? "" : "s"}
          </Button>
        </>
      )}
    </div>
  );
}
