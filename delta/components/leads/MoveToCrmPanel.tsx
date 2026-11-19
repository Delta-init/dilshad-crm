"use client";
import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Loader2, Send, Shuffle, Undo2, User as UserIcon, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import {
  moveError, useMoveTargets, useMoveToCrm, useUndoMoveToCrm,
  type MoveMode, type MoveResult,
} from "@/hooks/useCrmLeadMoves";

/*
 * Move leads to another sales CRM (2026-11-19): pick the CRM, then one person in a team there, split across one of its
 * teams, or that CRM's own split. Only open leads go; each leaves here once the other CRM has it ("Moved leads" keeps
 * it, with Undo for 24 hours). Used on a lead's page, by the Leads list's selection, and by Users → Transfer leads.
 */

interface Props {
  /** The leads picked — or `fromUserId`: every open lead that person holds. */
  leadIds?: string[];
  fromUserId?: string;
  /** What is being moved, for the button ("3 leads", "Ann's open leads"). */
  label: string;
  onDone?: (result: MoveResult) => void;
}

const field = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-50";

export function MoveToCrmPanel({ leadIds, fromUserId, label, onDone }: Props) {
  const targets = useMoveTargets(true);
  const [to, setTo] = useState("");
  const [mode, setMode] = useState<MoveMode>("person");
  const [teamId, setTeamId] = useState("");
  const [userId, setUserId] = useState("");
  const [done, setDone] = useState<MoveResult | null>(null);
  const [undone, setUndone] = useState<string[]>([]);
  const move = useMoveToCrm();
  const undo = useUndoMoveToCrm();

  const crm = targets.data?.find((t) => t.code === to);
  const team = crm?.teams.find((t) => t.id === teamId);
  const ready = !!crm && (mode === "split" || (!!team && (mode === "team" ? team.people.length > 0 : !!userId)));

  const go = () => {
    move.mutate({ leadIds, fromUserId, to, mode, teamId: mode === "split" ? null : teamId, userId: mode === "person" ? userId : null }, {
      onSuccess: (r) => {
        setDone(r);
        if (r.moved.length) toast.success(`${r.moved.length} lead${r.moved.length === 1 ? "" : "s"} moved to ${crm?.name ?? "the other CRM"}`);
        else toast.error("Nothing moved");
        onDone?.(r);
      },
      onError: (e) => toast.error(moveError(e, "Not moved")),
    });
  };

  const undoAll = async () => {
    for (const m of done?.moved ?? []) {
      if (undone.includes(m.leadId)) continue;
      try {
        await undo.mutateAsync(m.leadId);
        setUndone((u) => [...u, m.leadId]);
      } catch (e) {
        toast.error(`${m.name || "A lead"}: ${moveError(e, "not undone")}`);
      }
    }
  };

  if (targets.isLoading) return <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Asking Root where leads can go…</p>;
  if (targets.isError) return <p className="py-4 text-sm text-destructive">{moveError(targets.error, "Can't reach Root just now")}</p>;

  if (done) {
    const left = done.moved.filter((m) => !undone.includes(m.leadId));
    return (
      <div className="space-y-3 text-sm">
        {done.moved.length > 0 && (
          <div>
            <p className="font-medium">Moved {done.moved.length} to {crm?.name}:</p>
            <ul className="mt-1 max-h-48 space-y-1 overflow-y-auto">
              {done.moved.map((m) => (
                <li key={m.leadId} className={`flex items-center gap-2 ${undone.includes(m.leadId) ? "line-through text-muted-foreground" : ""}`}>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">{m.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {m.outcome === "repeat" ? `already there — to its team leader${m.holder ? ` (${m.holder})` : ""}` : m.holder ? `→ ${m.holder}` : "→ their split"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {done.refused.length > 0 && (
          <div>
            <p className="font-medium text-amber-700 dark:text-amber-500">Not moved ({done.refused.length}):</p>
            <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto text-xs">
              {done.refused.map((r) => <li key={r.leadId}><span className="font-medium">{r.name || "A lead"}</span> — {r.reason}</li>)}
            </ul>
          </div>
        )}
        {done.moved.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" disabled={undo.isPending || !left.length} onClick={undoAll}>
              {undo.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Undo2 className="mr-2 h-4 w-4" />}
              {left.length ? "Undo" : "Undone"}
            </Button>
            <Link href="/moved-leads" className="text-xs text-primary underline-offset-2 hover:underline">Moved leads</Link>
          </div>
        )}
        <p className="text-xs text-muted-foreground">Undo stays open for 24 hours on the Moved leads page — unless the lead has been closed there.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 text-sm">
      <div className="space-y-1.5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">To</p>
        <div className="grid grid-cols-2 gap-2">
          {(targets.data ?? []).map((t) => (
            <Button key={t.code} type="button" size="sm" variant={to === t.code ? "default" : "outline"} disabled={!t.ready || !!t.error}
              title={t.error ?? (t.ready ? "" : `Not set up on Root: ${t.missing.join(", ")}`)}
              onClick={() => { setTo(t.code); setTeamId(""); setUserId(""); }}>
              {t.name}
            </Button>
          ))}
        </div>
        {(targets.data ?? []).filter((t) => !t.ready || t.error).map((t) => (
          <p key={t.code} className="text-xs text-amber-700 dark:text-amber-500">{t.name}: {t.error ?? `not set up on Root yet (${t.missing.join(", ")})`}</p>
        ))}
      </div>

      {crm && (
        <>
          <div className="space-y-1.5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Who gets them</p>
            <div className="grid grid-cols-3 gap-2">
              <Button type="button" size="sm" variant={mode === "person" ? "default" : "outline"} onClick={() => setMode("person")}><UserIcon className="mr-1.5 h-4 w-4" />A person</Button>
              <Button type="button" size="sm" variant={mode === "team" ? "default" : "outline"} onClick={() => setMode("team")}><Users className="mr-1.5 h-4 w-4" />A team</Button>
              <Button type="button" size="sm" variant={mode === "split" ? "default" : "outline"} onClick={() => setMode("split")}><Shuffle className="mr-1.5 h-4 w-4" />Their split</Button>
            </div>
          </div>
          {mode !== "split" && (
            <select value={teamId} onChange={(e) => { setTeamId(e.target.value); setUserId(""); }} className={field} aria-label="Team">
              <option value="">Team in {crm.name}…</option>
              {crm.teams.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.people.length})</option>)}
            </select>
          )}
          {mode === "person" && (
            <select value={userId} onChange={(e) => setUserId(e.target.value)} className={field} disabled={!team} aria-label="Person">
              <option value="">{team ? "Person…" : "Pick a team first"}</option>
              {team?.people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.leader ? " (team leader)" : ""}</option>)}
            </select>
          )}
          <p className="text-xs text-muted-foreground">
            {mode === "person" ? "They all go to this person, in this team, as new leads."
              : mode === "team" ? `Shared out across ${team?.name ?? "the team"} in turn, whoever has fewest open leads first.`
              : `${crm.name} gives them out the way it gives out new leads.`}
            {" "}Only open leads move — closed and lost ones stay. A number {crm.name} already has goes to that lead&apos;s team leader. Their notes and history go with them; the WhatsApp chat doesn&apos;t.
          </p>
        </>
      )}

      <Button className="w-full" disabled={!ready || move.isPending} onClick={go}>
        {move.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
        Move {label}{crm ? ` to ${crm.name}` : ""}
      </Button>
    </div>
  );
}
