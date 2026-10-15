import type { Metadata, Viewport } from "next";

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

export default function PublicLeaderboardLayout({ children }: { children: React.ReactNode }) {
  return children;
}
