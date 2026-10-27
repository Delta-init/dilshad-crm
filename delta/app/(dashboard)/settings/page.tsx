"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import {
  Settings, DollarSign, Check, Phone, Download, ExternalLink,
  CheckCircle2, Circle, Copy, ChevronRight,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useCurrencyStore, CURRENCIES } from "@/lib/store/currencyStore";
import { chooseCurrency } from "@/hooks/useSyncedCurrency";
import { fmtCompact, fmtFull } from "@/lib/currency";
import { toast } from "@/lib/toast";
import { AutomationSettingsCard } from "@/components/settings/AutomationSettingsCard";
import { WhatsAppFollowupsCard } from "@/components/settings/WhatsAppFollowupsCard";

const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.07 } },
};

const itemVariants = {
  hidden:   { opacity: 0, y: 16 },
  visible:  { opacity: 1, y: 0, transition: { duration: 0.35, ease: "easeOut" } },
};

export default function SettingsPage() {
  const { currencyCode } = useCurrencyStore();

  // preview numbers re-render whenever currencyCode changes because we read the store
  const preview1 = fmtFull(1234567);
  const preview2 = fmtCompact(1234567);
  const preview3 = fmtFull(9999);

  return (
    <motion.div
      variants={containerVariants}
      initial="hidden"
      animate="visible"
      className="max-w-3xl mx-auto space-y-6 pb-10"
    >
      {/* Header */}
      <motion.div variants={itemVariants} className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
          <Settings className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-foreground">Settings</h1>
          <p className="text-sm text-muted-foreground">App-wide preferences</p>
        </div>
      </motion.div>

      {/* Currency section */}
      <motion.div variants={itemVariants}>
        <Card className="border-border/50 bg-card/80">
          <CardHeader className="pb-4">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-primary" />
              Currency
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Choose the currency displayed throughout the app — on reports, payments, courses, and revenue charts. Kept on
              your account, so it follows you to every device you sign in on.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">

            {/* Currency grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {CURRENCIES.map((c) => {
                const active = c.code === currencyCode;
                return (
                  <motion.button
                    key={c.code}
                    whileTap={{ scale: 0.97 }}
                    onClick={() => chooseCurrency(c.code)}
                    className={cn(
                      "relative flex items-center gap-3 rounded-xl border p-3 text-left transition-all duration-150",
                      active
                        ? "border-primary bg-primary/10 shadow-sm"
                        : "border-border/50 bg-card hover:border-primary/40 hover:bg-muted/40",
                    )}
                  >
                    <div className={cn(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-base font-bold",
                      active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                    )}>
                      {c.symbol.trim()}
                    </div>
                    <div className="min-w-0">
                      <p className={cn("text-xs font-semibold truncate", active ? "text-primary" : "text-foreground")}>
                        {c.code}
                      </p>
                      <p className="text-[10px] text-muted-foreground truncate leading-tight">
                        {c.label.split(" (")[0]}
                      </p>
                    </div>
                    {active && (
                      <motion.div
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        className="absolute top-2 right-2 flex h-4 w-4 items-center justify-center rounded-full bg-primary"
                      >
                        <Check className="h-2.5 w-2.5 text-primary-foreground" />
                      </motion.div>
                    )}
                  </motion.button>
                );
              })}
            </div>

            {/* Live preview */}
            <motion.div
              key={currencyCode}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25 }}
              className="rounded-xl border border-border/40 bg-muted/20 p-4"
            >
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-3">
                Preview
              </p>
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="space-y-0.5">
                  <p className="text-lg font-bold text-foreground tabular-nums">{preview2}</p>
                  <p className="text-[10px] text-muted-foreground">Compact</p>
                </div>
                <div className="space-y-0.5">
                  <p className="text-base font-bold text-foreground tabular-nums">{preview1}</p>
                  <p className="text-[10px] text-muted-foreground">Full</p>
                </div>
                <div className="space-y-0.5">
                  <p className="text-base font-bold text-foreground tabular-nums">{preview3}</p>
                  <p className="text-[10px] text-muted-foreground">Small</p>
                </div>
              </div>
            </motion.div>

          </CardContent>
        </Card>
      </motion.div>

      {/* 3CX Integration section */}
      <motion.div variants={itemVariants}>
        <Card className="border-border/50 bg-card/80">
          <CardHeader className="pb-4">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Phone className="h-4 w-4 text-primary" />
              3CX Phone Integration
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Connect your 3CX PBX to auto-log calls, display caller names, and enable click-to-call.
            </p>
          </CardHeader>
          <CardContent className="space-y-5">

            {/* Status badges */}
            <div className="flex flex-wrap gap-2">
              {[
                { label: "Contact Lookup", ok: true },
                { label: "Call Journaling", ok: true },
                { label: "Click-to-Call",  ok: true },
                { label: "Recordings",      ok: true },
              ].map(({ label, ok }) => (
                <span
                  key={label}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium",
                    ok
                      ? "bg-green-500/10 border-green-500/20 text-green-400"
                      : "bg-muted/40 border-border text-muted-foreground",
                  )}
                >
                  {ok
                    ? <CheckCircle2 className="h-3 w-3" />
                    : <Circle className="h-3 w-3" />
                  }
                  {label}
                </span>
              ))}
            </div>

            {/* API endpoint info */}
            <div className="rounded-xl border border-border/40 bg-muted/20 p-4 space-y-2">
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-3">
                CRM API Endpoint (used in 3CX XML)
              </p>
              {[
                { label: "Base URL",        value: "https://api-crm.deltainstitutions.com/api/v1/calls/" },
                { label: "Contact Lookup",  value: "GET /contact-lookup?phonenumber=[Number]" },
                { label: "Contact Search",  value: "GET /contact-search?search_string=[SearchQuery]" },
                { label: "Journal (POST)",  value: "POST /journal" },
                { label: "Webhook (GET)",   value: "GET /webhook?phonenumber=[Number]&..." },
              ].map(({ label, value }) => (
                <div key={label} className="flex items-start justify-between gap-3 text-xs">
                  <span className="text-muted-foreground shrink-0 w-28">{label}</span>
                  <code className="font-mono text-foreground/80 break-all text-right leading-relaxed">
                    {value}
                  </code>
                </div>
              ))}
            </div>

            {/* Setup steps */}
            <div className="space-y-2">
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Setup Steps
              </p>
              {[
                { step: 1, done: true,  text: "Enable REST API in 3CX Admin → API → Enable REST API" },
                { step: 2, done: true,  text: "Create API key — Client ID: deltaleads, copy key to backend .env" },
                { step: 3, done: true,  text: "Download XML template below and upload to 3CX Admin → CRM" },
                { step: 4, done: true,  text: "Set agent Extensions in CRM → Users → Edit each user" },
                { step: 5, done: true,  text: "Test: make a call — it should auto-log in Calls page" },
              ].map(({ step, done, text }) => (
                <motion.div
                  key={step}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: step * 0.05 }}
                  className={cn(
                    "flex items-start gap-3 rounded-lg border p-3 text-xs",
                    done
                      ? "border-green-500/20 bg-green-500/5"
                      : "border-border/40 bg-muted/20",
                  )}
                >
                  <span className={cn(
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold mt-0.5",
                    done ? "bg-green-500 text-white" : "bg-muted text-muted-foreground",
                  )}>
                    {done ? <Check className="h-3 w-3" /> : step}
                  </span>
                  <span className={done ? "text-foreground/70 line-through" : "text-foreground"}>
                    {text}
                  </span>
                </motion.div>
              ))}
            </div>

            {/* Download + links */}
            <div className="flex flex-wrap gap-2 pt-1">
              <motion.div whileTap={{ scale: 0.97 }}>
                <Button
                  size="sm"
                  className="gap-2"
                  onClick={() => {
                    window.open("https://api-crm.deltainstitutions.com/api/v1/calls/3cx-template", "_blank");
                    toast.success("3CX XML template downloading…");
                  }}
                >
                  <Download className="h-3.5 w-3.5" />
                  Download 3CX XML Template
                </Button>
              </motion.div>
              <motion.div whileTap={{ scale: 0.97 }}>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-2"
                  onClick={() => {
                    navigator.clipboard.writeText("https://api-crm.deltainstitutions.com/api/v1/calls/");
                    toast.success("API base URL copied!");
                  }}
                >
                  <Copy className="h-3.5 w-3.5" />
                  Copy API URL
                </Button>
              </motion.div>
              <motion.div whileTap={{ scale: 0.97 }}>
                <Button
                  size="sm"
                  variant="ghost"
                  className="gap-2 text-muted-foreground"
                  onClick={() => window.open("https://deltainstitutions.3cx.ae:5002", "_blank")}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Open 3CX Admin
                </Button>
              </motion.div>
            </div>

          </CardContent>
        </Card>
      </motion.div>

      {/* Automation & alerts — inactive leads, idle alerts, working hours, email */}
      <motion.div variants={itemVariants}>
        <AutomationSettingsCard />
      </motion.div>

      {/* Automatic WhatsApp follow-ups — Super Admin only (shows nothing to anyone else) */}
      <motion.div variants={itemVariants}>
        <WhatsAppFollowupsCard />
      </motion.div>
    </motion.div>
  );
}
