"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { MessageCircle, Repeat } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/lib/toast";
import { Composer, Thread, WA_GREEN } from "@/components/whatsapp/waUi";
import { errMsg, useLeadFollowupStop, useLeadWhatsApp, useWhatsAppSend, type WAFollowup } from "@/hooks/useWhatsApp";

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Dubai", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");

/** One line: where the automatic follow-ups stand for this lead, with Stop / Resume. Nothing when they are off for the team. */
function FollowupLine({ leadId, f }: { leadId: string; f?: WAFollowup }) {
  const stop = useLeadFollowupStop();
  if (!f?.on) return null;
  const text: Record<WAFollowup["state"], string> = {
    off: "", ended: "Off — the lead is closed, lost or repeated",
    no_chat: "Starts once their salesperson messages them on WhatsApp",
    replied: "They answered — none due",
    before: "None for this chat (it went quiet before follow-ups were switched on)",
    stopped: `Stopped${f.byName ? ` by ${f.byName}` : ""} — writing to them starts them again`,
    done: `All ${f.sent ?? ""} sent — no answer`,
    waiting: `Step ${f.step} of ${f.of} next, ${when(f.nextAt)}${f.ownerName ? ` from ${f.ownerName}'s WhatsApp` : ""}${f.linked === false ? " (not linked — won't go until it is)" : ""}`,
  };
  const act = async (s: boolean) => {
    try { await stop.mutateAsync({ leadId, stop: s }); toast.success(s ? "Follow-ups stopped" : "Follow-ups resumed"); }
    catch (e) { toast.error(errMsg(e, "Not changed")); }
  };
  return (
    <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2 text-xs">
      <span className="flex items-center gap-1.5 text-muted-foreground"><Repeat className="h-3.5 w-3.5" />Auto follow-up: {text[f.state]}</span>
      {f.state === "waiting" && <Button size="sm" variant="outline" className="h-7 text-xs" disabled={stop.isPending} onClick={() => act(true)}>Stop</Button>}
      {f.state === "stopped" && <Button size="sm" variant="outline" className="h-7 text-xs" disabled={stop.isPending} onClick={() => act(false)}>Resume</Button>}
    </div>
  );
}

/**
 * The lead page's WhatsApp (2026-10-27, as Tetra Commission's student card): their chats you may read — yours, and for
 * a team leader, the Sales Manager or a Super Admin their people's — and, when your WhatsApp is linked, a box to
 * message them on one of the numbers on their record.
 */
export function LeadWhatsAppCard({ leadId }: { leadId: string }) {
  const { data } = useLeadWhatsApp(leadId);
  const send = useWhatsAppSend();
  const [number, setNumber] = useState("");
  useEffect(() => { if (!number && data?.numbers?.length) setNumber(data.numbers[0]!); }, [data?.numbers, number]);
  if (!data) return null;
  const threads = data.threads ?? [];
  const mine = threads.filter((t) => t.ownerId === data.me);
  const others = threads.filter((t) => t.ownerId !== data.me);
  if (!threads.length && !data.canLink) return null;   // nothing to read, and not someone who could write

  const sendText = async (text: string) => {
    try { await send.text.mutateAsync({ chat: number, text }); } catch (e) { toast.error(errMsg(e, "Not sent")); throw e; }
  };
  const sendFile = async (file: File, caption: string, voice = false) => {
    try { await send.file.mutateAsync({ chat: number, file, caption, voice }); } catch (e) { toast.error(errMsg(e, "Not sent")); throw e; }
  };
  const myMessages = mine.flatMap((t) => t.messages).sort((a, b) => String(a.at).localeCompare(String(b.at)));

  return (
    <Card className="overflow-hidden border-border/50">
      <CardHeader className="border-b pb-3">
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2"><MessageCircle className="h-4 w-4" style={{ color: WA_GREEN }} />WhatsApp</span>
          <Link href="/whatsapp" className="text-xs font-normal text-primary hover:underline">All chats</Link>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <FollowupLine leadId={leadId} f={data.followup} />
        {data.canLink && (
          <>
            <Thread messages={myMessages} className="max-h-96 min-h-32" empty={data.linked ? "No messages with them yet" : "Your WhatsApp is not linked"} />
            {data.canSend && data.numbers.length > 0 && (
              <>
                {data.numbers.length > 1 && (
                  <div className="flex items-center gap-2 border-t px-3 py-2 text-sm">
                    <span className="text-muted-foreground">To</span>
                    <Select value={number} onValueChange={setNumber}>
                      <SelectTrigger className="h-8 w-56"><SelectValue /></SelectTrigger>
                      <SelectContent>{data.numbers.map((n) => <SelectItem key={n} value={n}>+{n}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                )}
                <Composer onSendText={sendText} onSendFile={sendFile} placeholder={`Message +${number}`} />
              </>
            )}
            {data.canSend && data.numbers.length === 0 && <p className="border-t p-3 text-center text-xs text-muted-foreground">No phone number on their record</p>}
            {!data.linked && (
              <p className="border-t p-3 text-center text-xs text-muted-foreground">
                <Link href="/whatsapp" className="text-primary hover:underline">Link your WhatsApp</Link> to message them from here
              </p>
            )}
          </>
        )}
        {others.map((t) => (
          <div key={`${t.ownerId}|${t.chat}`} className="border-t">
            <p className="bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">{t.ownerName}&apos;s WhatsApp{t.phone ? ` · +${t.phone}` : ""} — read only</p>
            <Thread messages={t.messages} className="max-h-80" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
