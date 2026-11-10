"use client";
import { useState } from "react";
import { Loader2, AlertTriangle } from "lucide-react";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
} from "@/components/ui/responsive-dialog";
import { Button } from "@/components/ui/button";
import { useDeleteUser } from "@/hooks/useUsers";
import { useTransferSummary } from "@/hooks/useLeadTransfer";
import { TransferLeadsPanel } from "@/components/users/TransferLeadsPanel";
import type { User } from "@/types";

interface DeleteUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: User | null;
}

/*
 * Delete (2026-11-10): someone still holding open leads gives them up first — to one person or split — then goes.
 * Anyone with history (closed or lost leads, commission) is deactivated rather than erased, so their name stays on it.
 */
export function DeleteUserDialog({ open, onOpenChange, user }: DeleteUserDialogProps) {
  const { mutate: deleteUser, isPending } = useDeleteUser();
  const summary = useTransferSummary(open && user ? user._id : null);
  const [moved, setMoved] = useState(false);
  const holding = (summary.data?.open ?? 0) > 0 && !moved;
  const history = (summary.data?.closed ?? 0) + (summary.data?.lost ?? 0) > 0;

  const handleDelete = () => {
    if (!user) return;
    deleteUser(user._id, { onSuccess: () => { setMoved(false); onOpenChange(false); } });
  };

  return (
    <ResponsiveDialog open={open} onOpenChange={(o) => { if (!o) setMoved(false); onOpenChange(o); }}>
      <ResponsiveDialogContent desktopClassName={holding ? "max-w-lg" : "max-w-sm"}>
        <ResponsiveDialogHeader>
          <div className="flex items-center gap-3 px-4 sm:px-0">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-destructive/10">
              <AlertTriangle className="h-5 w-5 text-destructive" />
            </div>
            <ResponsiveDialogTitle>Delete User</ResponsiveDialogTitle>
          </div>
          <ResponsiveDialogDescription className="pt-2 px-4 sm:px-0">
            {summary.isLoading ? "Checking their leads…"
              : holding ? <>First, where do <strong className="text-foreground">{user?.name}</strong>&apos;s open leads go?</>
              : history ? <><strong className="text-foreground">{user?.name}</strong> will be deactivated, not erased — their closed and lost leads keep their name.</>
              : <>Are you sure you want to delete <strong className="text-foreground">{user?.name}</strong>? This action cannot be undone.</>}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        {holding && user && (
          <div className="px-4 pb-2 sm:px-0">
            <TransferLeadsPanel key={user._id} userId={user._id} userName={user.name} reason="remove" onDone={() => { setMoved(true); summary.refetch(); }} />
          </div>
        )}
        <ResponsiveDialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={isPending || summary.isLoading || holding}
          >
            {isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            {history ? "Deactivate User" : "Delete User"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
