"use client";

import { useState } from "react";
import { PhoneCall, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useLeadCallLog } from "@/hooks/useCalls";
import { ClickToCall } from "@/components/leads/ClickToCall";
import { CallPerson, CallResult, RecordingPlayer, SyncNote, fmtClockDuration, fmtTalkTotal, fmtWhen } from "@/components/calls/callUi";

const FIRST = 8;

interface CallsPanelProps {
  leadId:  string;
  phone:   string;
  leadName?: string;
}

/**
 * A lead's calls through 3CX (2026-10-14): when, in or out, connected or missed, who took it, how long, and the
 * recording — synced from 3CX every minute. Only 3CX's calls. The Call button opens the call flow (3CX or phone,
 * then "How did the call go?" — components/calls/CallFlow.tsx).
 */
export function CallsPanel({ leadId, phone, leadName }: CallsPanelProps) {
  const { data, isLoading, error, refetch, isFetching } = useLeadCallLog(leadId);
  const [all, setAll] = useState(false);
  const calls = data?.calls ?? [];
  const stats = data?.stats;
  const list = all ? calls : calls.slice(0, FIRST);

  const summary = stats?.total
    ? [
      `${stats.total} call${stats.total === 1 ? "" : "s"}`,
      stats.outgoing && `${stats.outgoing} out`,
      stats.incoming && `${stats.incoming} in`,
      stats.connected && `${stats.connected} connected`,
      stats.missed && `${stats.missed} missed`,
      stats.notAnswered && `${stats.notAnswered} not answered`,
      stats.talkSeconds && `${fmtTalkTotal(stats.talkSeconds)} talking`,
    ].filter(Boolean).join(" · ")
    : null;

  return (
    <Card className="border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <PhoneCall className="h-4 w-4 text-primary" />
            Calls
          </CardTitle>
          <div className="flex items-center gap-2">
            <ClickToCall phoneNumber={phone} leadId={leadId} leadName={leadName} variant="outline" size="sm" showLabel={true} />
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => refetch()} disabled={isFetching} title="Refresh">
              <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{summary || "Calls with this lead through 3CX"}</p>
        <SyncNote threecx={data?.threecx} />
      </CardHeader>

      <CardContent className="p-0">
        {isLoading ? (
          <div className="space-y-2 px-6 pb-6">{[1, 2, 3].map((i) => <div key={i} className="h-12 animate-pulse rounded-lg bg-muted/40" />)}</div>
        ) : error ? (
          <p className="px-6 pb-6 text-sm text-destructive">Could not load the calls.</p>
        ) : calls.length === 0 ? (
          <p className="px-6 pb-6 text-center text-sm text-muted-foreground">No calls with this lead through 3CX yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2 text-left font-medium">When</th>
                  <th className="px-4 py-2 text-left font-medium">Call</th>
                  <th className="px-4 py-2 text-left font-medium">Who</th>
                  <th className="px-4 py-2 text-right font-medium">Talk</th>
                  <th className="px-4 py-2 text-left font-medium">Recording</th>
                </tr>
              </thead>
              <tbody>
                {list.map((c) => (
                  <tr key={c.id} className="border-b border-border/50 align-top">
                    <td className="whitespace-nowrap px-4 py-2.5 text-xs">{fmtWhen(c.startedAt)}</td>
                    <td className="px-4 py-2.5"><CallResult call={c} /></td>
                    <td className="px-4 py-2.5"><CallPerson call={c} /></td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right text-xs tabular-nums">
                      {c.talkSeconds ? fmtClockDuration(c.talkSeconds) : <span className="text-muted-foreground/40">—</span>}
                    </td>
                    <td className="px-4 py-2"><RecordingPlayer call={c} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {calls.length > FIRST && (
              <div className="border-t border-border px-3 py-2 text-center">
                <Button variant="ghost" size="sm" onClick={() => setAll((a) => !a)}>{all ? "Show fewer" : `Show all ${calls.length} calls`}</Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
