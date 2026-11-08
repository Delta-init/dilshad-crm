"use client";

import Link from "next/link";
import { ArrowRight, MessageCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/*
 * WhatsApp follow-ups and the first reply are each team's own since 2026-11-08 (Teams → the team → WhatsApp, set by a
 * Super Admin or the team's leader): this card only says where they went.
 */
export function WhatsAppFollowupsCard() {
  return (
    <Card className="border-border/50 bg-card/80">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <MessageCircle className="h-4 w-4 text-primary" />
          WhatsApp follow-ups
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-muted-foreground">
        <p>Each team has its own automatic follow-ups and first reply now — set by a Super Admin or the team&apos;s leader on the team&apos;s page.</p>
        <Link href="/teams" className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline">
          Teams → pick a team → WhatsApp <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </CardContent>
    </Card>
  );
}
