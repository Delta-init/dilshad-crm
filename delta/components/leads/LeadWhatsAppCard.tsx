"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { MessageCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/lib/toast";
import { Composer, Thread, WA_GREEN } from "@/components/whatsapp/waUi";
import { errMsg, useLeadWhatsApp, useWhatsAppSend } from "@/hooks/useWhatsApp";

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
