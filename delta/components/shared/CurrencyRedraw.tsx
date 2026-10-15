"use client";

import { Fragment } from "react";
import { useCurrencyRedraw } from "@/hooks/useSyncedCurrency";

/**
 * Draws the page again when the account's currency arrives as the app opens (2026-10-15) — money is formatted as it's
 * drawn, and most screens don't listen for the currency, so one screen could otherwise show two symbols. Only then
 * (not on a pick in Settings, nor while someone is typing — see useSyncedCurrency).
 */
export function CurrencyRedraw({ children }: { children: React.ReactNode }) {
  const key = useCurrencyRedraw((s) => s.key);
  return <Fragment key={key}>{children}</Fragment>;
}
