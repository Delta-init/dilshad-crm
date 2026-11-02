import type { Metadata, Viewport } from "next";
import Script from "next/script";

/** The open leaderboard's own title — what a shared link shows. No sign-in here. */
export const metadata: Metadata = {
  title: "Leaderboard — Remote CRM",
  description: "This month's sales leaderboard: revenue, closings and calls — live.",
  openGraph: { type: "website", siteName: "Remote CRM", title: "Leaderboard — Remote CRM", description: "This month's sales leaderboard: revenue, closings and calls — live." },
  twitter: { card: "summary", title: "Leaderboard — Remote CRM", description: "This month's sales leaderboard: revenue, closings and calls — live." },
  // Open to anyone with the link, but not for search engines.
  robots: { index: false, follow: false },
};

// The board is dark unless a screen asks for light, so phones get a dark status bar.
export const viewport: Viewport = { themeColor: "#0b1120" };

/*
 * The office TVs' photos and videos (2026-11-02): Root's overlay plays the ones a root admin chose for this TV, then
 * the leaderboard for its minute, and again. Nothing chosen, or Root unreachable: the leaderboard as before.
 */
const ROOT_API = (process.env.NEXT_PUBLIC_ROOT_API_URL ?? "https://root-api-sales-crm.deltainstitutions.com").replace(/\/+$/, "");

export default function PublicLeaderboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <Script src={`${ROOT_API}/api/v1/public/tv/overlay.js?screen=remote`} strategy="afterInteractive" />
    </>
  );
}
