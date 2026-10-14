"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, RefreshCw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { testThreecx, type ThreecxTestResult } from "@/hooks/useCalls";

/**
 * Super Admin: the 3CX connection step by step, as in Tetra Commission
 * (2026-10-14) — the settings, signing in, 3CX's users and extensions, the last
 * 24 hours of calls and one recording — with a few rows as 3CX sends them and
 * as they were read. Runs each time it opens.
 */
export function ThreecxTestDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ThreecxTestResult | null>(null);

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await testThreecx());
    } catch (e) {
      const err = e as { response?: { status?: number; data?: { message?: string } }; message?: string };
      const detail = err.response?.status === 404
        ? "The CRM's server is still on the previous version — Test connection works once it is updated."
        : err.response?.data?.message || err.message || "Could not run the test";
      setResult({ ok: false, steps: [{ name: "Test", ok: false, detail }] });
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (open) void run();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const pre = "mt-2 max-h-72 overflow-auto rounded-lg bg-muted p-3 text-[11px] leading-relaxed text-foreground";

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>3CX connection</DialogTitle>
          <DialogDescription>
            Signs in with the API key on the server, reads 3CX&apos;s users (filling in empty extensions by email) and the last 24 hours of calls, and opens one recording. Nothing in 3CX is changed.
          </DialogDescription>
        </DialogHeader>
        {busy ? (
          <p className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Talking to 3CX…
          </p>
        ) : result && (
          <div className="space-y-4">
            <ol className="space-y-2.5">
              {result.steps.map((s) => (
                <li key={s.name} className="flex items-start gap-2.5">
                  {s.ok
                    ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                    : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" />}
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground">{s.name}</div>
                    <div className="break-words text-sm text-muted-foreground">{s.detail}</div>
                  </div>
                </li>
              ))}
            </ol>
            {!!result.parsed?.length && (
              <details>
                <summary className="cursor-pointer text-sm font-medium text-foreground">Calls with leads, as read ({result.parsed.length})</summary>
                <pre className={pre}>{JSON.stringify(result.parsed, null, 2)}</pre>
              </details>
            )}
            {!!result.sample?.length && (
              <details>
                <summary className="cursor-pointer text-sm font-medium text-foreground">Rows as 3CX sends them ({result.sample.length})</summary>
                <pre className={pre}>{JSON.stringify(result.sample, null, 2)}</pre>
              </details>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={run} disabled={busy}>
            <RefreshCw className="mr-2 h-4 w-4" /> Run again
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
