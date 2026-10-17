"use client";
import { useState } from "react";
import { motion } from "framer-motion";
import { CalendarDays, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn, gstTodayISO } from "@/lib/utils";

/** The first day of this week (Monday) or month, as a GST "YYYY-MM-DD". */
function gstPeriodStartISO(period: "week" | "month"): string {
  const [y, m, d] = gstTodayISO().split("-").map(Number);
  if (period === "month") return new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return new Date(Date.UTC(y, m - 1, d - ((dow + 6) % 7))).toISOString().slice(0, 10);
}

interface DayRangeFilterProps {
  /** What the dates mean, e.g. "Assigned" or "Moved". */
  label: string;
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  className?: string;
}

/** "YYYY-MM-DD" one day before a GST date. */
function dayBefore(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const fmt = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** A Dubai-day range: quick picks plus from/to dates, in one compact button. */
export function DayRangeFilter({ label, from, to, onChange, className }: DayRangeFilterProps) {
  const [open, setOpen] = useState(false);
  const today = gstTodayISO();
  const quick: { id: string; label: string; from: string; to: string }[] = [
    { id: "today", label: "Today", from: today, to: today },
    { id: "yesterday", label: "Yesterday", from: dayBefore(today), to: dayBefore(today) },
    { id: "week", label: "This week", from: gstPeriodStartISO("week"), to: today },
    { id: "month", label: "This month", from: gstPeriodStartISO("month"), to: today },
  ];
  const active = quick.find((q) => q.from === from && q.to === to);
  const set = Boolean(from || to);
  const summary = `${label}: ${active ? active.label : set ? `${from ? fmt(from) : "…"} – ${to ? fmt(to) : "…"}` : "any day"}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <motion.button
          type="button"
          whileTap={{ scale: 0.97 }}
          aria-label={`${label} date range`}
          className={cn(
            "inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-md border px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            set ? "border-primary/40 bg-primary/5 text-primary" : "border-input bg-background text-muted-foreground hover:text-foreground",
            className,
          )}
        >
          <CalendarDays className="h-4 w-4 shrink-0" />
          <span className="truncate">{summary}</span>
          {set && (
            <span
              role="button"
              tabIndex={0}
              aria-label="Clear dates"
              onClick={(e) => { e.stopPropagation(); onChange("", ""); }}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onChange("", ""); } }}
              className="ml-0.5 rounded-full p-0.5 hover:bg-primary/10"
            >
              <X className="h-3 w-3" />
            </span>
          )}
        </motion.button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3 p-3">
        <p className="text-xs font-medium text-muted-foreground">{label} between · Dubai days</p>
        <div className="grid grid-cols-2 gap-1.5">
          {quick.map((q) => (
            <Button
              key={q.id}
              type="button"
              size="sm"
              variant={active?.id === q.id ? "default" : "outline"}
              className="h-8 text-xs"
              onClick={() => { onChange(q.from, q.to); setOpen(false); }}
            >
              {q.label}
            </Button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1 text-[11px] text-muted-foreground">
            From
            <Input id={`${label}-from`} type="date" value={from} max={to || undefined} onChange={(e) => onChange(e.target.value, to)} className="h-8 text-xs" />
          </label>
          <label className="space-y-1 text-[11px] text-muted-foreground">
            To
            <Input id={`${label}-to`} type="date" value={to} min={from || undefined} onChange={(e) => onChange(from, e.target.value)} className="h-8 text-xs" />
          </label>
        </div>
        {set && (
          <Button type="button" variant="ghost" size="sm" className="h-8 w-full text-xs" onClick={() => { onChange("", ""); setOpen(false); }}>
            Clear dates
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
