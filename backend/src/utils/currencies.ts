/**
 * The currencies a person can pick to see amounts in (Settings → Currency, 2026-10-15) — the same list as the web
 * app's lib/store/currencyStore.ts. Only the symbol and the number format change; no amount is converted.
 */
export const DISPLAY_CURRENCIES = ["USD", "INR", "EUR", "GBP", "AED", "SAR", "CAD", "AUD", "SGD", "JPY", "MYR"] as const;

export type DisplayCurrency = (typeof DISPLAY_CURRENCIES)[number];
