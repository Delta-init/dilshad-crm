"use client";
import { Send } from "lucide-react";
import {
  ResponsiveDialog, ResponsiveDialogContent, ResponsiveDialogHeader, ResponsiveDialogTitle, ResponsiveDialogDescription,
} from "@/components/ui/responsive-dialog";
import { MoveToCrmPanel } from "@/components/leads/MoveToCrmPanel";
import type { MoveResult } from "@/hooks/useCrmLeadMoves";

/* "Move to another CRM" (2026-11-19) — a lead's page and the Leads list's selection. */
export function MoveToCrmDialog({ open, onOpenChange, leadIds, label, onDone }: {
  open: boolean; onOpenChange: (open: boolean) => void; leadIds: string[]; label: string; onDone?: (r: MoveResult) => void;
}) {
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent desktopClassName="max-w-lg">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle className="flex items-center gap-2 px-4 sm:px-0"><Send className="h-5 w-5" />Move to another CRM</ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="px-4 sm:px-0">Send {label} to the Sales, Draw or Remote CRM.</ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <div className="px-4 pb-4 sm:px-0 sm:pb-0">
          {open && <MoveToCrmPanel key={leadIds.join(",")} leadIds={leadIds} label={label} onDone={onDone} />}
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
