"use client";
import { useState } from "react";
import { ArrowRightLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ResponsiveDialog, ResponsiveDialogContent, ResponsiveDialogHeader, ResponsiveDialogTitle, ResponsiveDialogDescription,
} from "@/components/ui/responsive-dialog";
import { TransferLeadsPanel } from "@/components/users/TransferLeadsPanel";
import { MoveToCrmPanel } from "@/components/leads/MoveToCrmPanel";
import { useMayMoveToCrm } from "@/hooks/useCrmLeadMoves";
import type { User } from "@/types";

/*
 * Users → Transfer leads (2026-11-10): a person's open leads to one person or split. Since 2026-11-19 also to another
 * CRM (Sales, Draw, Remote) — for those who may move leads between CRMs.
 */
export function TransferLeadsDialog({ open, onOpenChange, user }: { open: boolean; onOpenChange: (open: boolean) => void; user: User | null }) {
  const { data: mayMove = false } = useMayMoveToCrm();
  const [where, setWhere] = useState<"here" | "crm">("here");
  const crm = mayMove && where === "crm";
  return (
    <ResponsiveDialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) setWhere("here"); }}>
      <ResponsiveDialogContent desktopClassName="max-w-lg">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle className="flex items-center gap-2 px-4 sm:px-0"><ArrowRightLeft className="h-5 w-5" />Transfer leads</ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="px-4 sm:px-0">
            {crm
              ? <>Move {user?.name ?? "their"}&apos;s open leads to another CRM.</>
              : <>Move {user?.name ?? "their"}&apos;s open leads to one person, or split them between several.</>}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <div className="space-y-4 px-4 pb-4 sm:px-0 sm:pb-0">
          {mayMove && (
            <div className="grid grid-cols-2 gap-2">
              <Button type="button" size="sm" variant={where === "here" ? "secondary" : "ghost"} onClick={() => setWhere("here")}>In this CRM</Button>
              <Button type="button" size="sm" variant={where === "crm" ? "secondary" : "ghost"} onClick={() => setWhere("crm")}>To another CRM</Button>
            </div>
          )}
          {open && user && (crm
            ? <MoveToCrmPanel key={`crm-${user._id}`} fromUserId={user._id} label={`${user.name}'s open leads`} />
            : <TransferLeadsPanel key={user._id} userId={user._id} userName={user.name} />)}
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
