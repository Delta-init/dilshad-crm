"use client";
import { motion } from "framer-motion";
import Link from "next/link";
import {
  Users, Shield, Activity, TrendingUp, FileText, UserX,
  Trophy, Crown, Medal,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuthStore } from "@/lib/store/authStore";
import { useLeads } from "@/hooks/useLeads";
import { useReportTeamRankings } from "@/hooks/useReports";
import { cn } from "@/lib/utils";
import { useCurrencyStore } from "@/lib/store/currencyStore";
import { fmtFull } from "@/lib/currency";
import { DashboardLeaderboardCard } from "@/components/dashboard/DashboardLeaderboardCard";
import { DashboardPayCard } from "@/components/pay/DashboardPayCard";
import { WalletCard } from "@/components/wallet/WalletCard";
import { DailyFollowupsPopup } from "@/components/leads/DailyFollowupsPopup";

const containerVariants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.08 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: "easeOut" } },
};

const MEDAL_COLORS = ["text-yellow-400", "text-neutral-400", "text-amber-600"];
const MEDAL_BG    = ["bg-yellow-400/10", "bg-neutral-400/10", "bg-amber-600/10"];

export default function DashboardPage() {
  useCurrencyStore(); // subscribe so component re-renders on currency change
  const { user } = useAuthStore();

  const { data: allLeadsData }        = useLeads({ page: 1, limit: 1 });
  const { data: unassignedLeadsData } = useLeads({ page: 1, limit: 1, assignedTo: "unassigned" });
  const teamRanks                     = useReportTeamRankings("", "");

  const totalLeads      = allLeadsData?.pagination?.total;
  const unassignedLeads = unassignedLeadsData?.pagination?.total;
  const topTeams        = teamRanks.data?.slice(0, 5) ?? [];

  const stats = [
    {
      title: "Total Users",
      value: "—",
      description: "Manage team members",
      icon: Users,
      color: "text-blue-400",
      bg: "bg-blue-500/10",
    },
    {
      title: "Roles",
      value: "—",
      description: "Permission groups",
      icon: Shield,
      color: "text-purple-400",
      bg: "bg-purple-500/10",
    },
    {
      title: "Active Users",
      value: "—",
      description: "Currently active",
      icon: Activity,
      color: "text-green-400",
      bg: "bg-green-500/10",
    },
    {
      title: "Modules",
      value: "9",
      description: "System modules",
      icon: TrendingUp,
      color: "text-amber-400",
      bg: "bg-amber-500/10",
    },
    {
      title: "Total Leads",
      value: totalLeads !== undefined ? String(totalLeads) : "—",
      description: "All leads in system",
      icon: FileText,
      color: "text-cyan-400",
      bg: "bg-cyan-500/10",
    },
    {
      title: "Unassigned Leads",
      value: unassignedLeads !== undefined ? String(unassignedLeads) : "—",
      description: "Pending assignment",
      icon: UserX,
      color: "text-rose-400",
      bg: "bg-rose-500/10",
    },
  ];

  return (
    <div className="space-y-8">
      {/* Welcome */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
      >
        <h2 className="text-2xl font-bold text-foreground">
          Welcome back, {user?.name?.split(" ")[0]} 👋
        </h2>
        <p className="text-muted-foreground mt-1">
          Here&apos;s an overview of your CRM system.
        </p>
        {/* Daily follow-up pop-up + reopen chip */}
        <div className="mt-3">
          <DailyFollowupsPopup />
        </div>
      </motion.div>

      {/* First in the row: this month's pay from the HRMS — earned, deducted, paid (2026-11-04) */}
      <WalletCard />

      {/* This month's leaderboard */}
      {/* This month on the salary slab */}
      <DashboardPayCard />

      <DashboardLeaderboardCard />

      {/* Stats Grid */}
      <motion.div
        variants={containerVariants}
        initial="hidden"
        animate="show"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
      >
        {stats.map((stat) => (
          <motion.div key={stat.title} variants={itemVariants}>
            <Card className="border-border/50 hover:border-border transition-colors">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {stat.title}
                </CardTitle>
                <div className={`rounded-lg p-2 ${stat.bg}`}>
                  <stat.icon className={`h-4 w-4 ${stat.color}`} />
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold text-foreground">{stat.value}</p>
                <p className="text-xs text-muted-foreground mt-1">{stat.description}</p>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </motion.div>

      {/* Team Rankings */}
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.22, duration: 0.4 }}
      >
        <Card className="border-border/50">
          <CardHeader className="pb-3 flex flex-row items-center justify-between">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <Trophy className="h-4 w-4 text-amber-400" />
              Team Performance Rankings
            </CardTitle>
            <Link
              href="/reports"
              className="text-xs text-muted-foreground hover:text-primary transition-colors"
            >
              View full report →
            </Link>
          </CardHeader>
          <CardContent className="pt-0">
            {teamRanks.isLoading ? (
              <div className="space-y-3">
                {[1, 2, 3, 4, 5].map((i) => (
                  <Skeleton key={i} className="h-14 w-full rounded-lg" />
                ))}
              </div>
            ) : topTeams.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                No team data available yet.
              </p>
            ) : (
              <div className="space-y-2">
                {topTeams.map((team, idx) => {
                  const isMedal    = idx < 3;
                  const medalColor = isMedal ? MEDAL_COLORS[idx] : "text-muted-foreground";
                  const medalBg    = isMedal ? MEDAL_BG[idx]    : "bg-muted/60";
                  const maxRev     = topTeams[0]?.totalPayments ?? 1;
                  const barPct     = maxRev > 0 ? ((team.totalPayments ?? 0) / maxRev) * 100 : 0;

                  return (
                    <motion.div
                      key={team.teamId}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: idx * 0.07 }}
                      className="flex items-center gap-3 rounded-lg border border-border/40 p-3 hover:bg-muted/20 transition-colors"
                    >
                      {/* Rank badge */}
                      <div
                        className={cn(
                          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                          medalBg,
                        )}
                      >
                        {isMedal ? (
                          <Medal className={cn("h-4 w-4", medalColor)} />
                        ) : (
                          <span className="text-xs font-bold text-muted-foreground">{idx + 1}</span>
                        )}
                      </div>

                      {/* Team info + bar */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between mb-1.5">
                          <Link
                            href={`/teams/${team.teamId}`}
                            className="text-sm font-semibold text-foreground hover:text-primary truncate max-w-[160px] sm:max-w-xs transition-colors"
                          >
                            {team.name}
                          </Link>
                          <span className="text-sm font-bold text-emerald-400 tabular-nums shrink-0 ml-2">
                            {fmtFull(team.totalPayments ?? 0)}
                          </span>
                        </div>
                        {/* Revenue progress bar */}
                        <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                          <motion.div
                            initial={{ width: 0 }}
                            animate={{ width: `${barPct}%` }}
                            transition={{ duration: 0.8, ease: "easeOut", delay: idx * 0.07 + 0.2 }}
                            className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-green-400"
                          />
                        </div>
                        <div className="flex items-center gap-3 mt-1">
                          <span className="text-[10px] text-muted-foreground">
                            {team.memberCount} members · {team.total} leads
                          </span>
                          <span className="text-[10px] text-violet-400 font-medium">
                            {team.thisMonth ?? 0} this month
                          </span>
                          <span className="text-[10px] text-green-500">
                            {team.closed} closed · {team.conversionRate}% conv
                          </span>
                        </div>
                      </div>

                      {/* Leader crown if rank 1 */}
                      {idx === 0 && (
                        <Crown className="h-5 w-5 text-yellow-400 shrink-0" />
                      )}
                    </motion.div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
