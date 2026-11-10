"use client";
import { ArrowRightLeft } from "lucide-react";
import {
  ResponsiveDialog, ResponsiveDialogContent, ResponsiveDialogHeader, ResponsiveDialogTitle, ResponsiveDialogDescription,
} from "@/components/ui/responsive-dialog";
import { TransferLeadsPanel } from "@/components/users/TransferLeadsPanel";
import type { User } from "@/types";

/* Users → Transfer leads (2026-11-10): a person's open leads to one person or split. */
export function TransferLeadsDialog({ open, onOpenChange, user }: { open: boolean; onOpenChange: (open: boolean) => void; user: User | null }) {
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent desktopClassName="max-w-lg">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle className="flex items-center gap-2 px-4 sm:px-0"><ArrowRightLeft className="h-5 w-5" />Transfer leads</ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="px-4 sm:px-0">
            Move {user?.name ?? "their"}&apos;s open leads to one person, or split them between several.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <div className="px-4 pb-4 sm:px-0 sm:pb-0">
          {open && user && <TransferLeadsPanel key={user._id} userId={user._id} userName={user.name} />}
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
