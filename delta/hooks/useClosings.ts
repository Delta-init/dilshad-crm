import { useQuery } from "@tanstack/react-query";
import api from "@/lib/axios";

const KEY = ["closings"] as const;

/** One enrolment, as the closing book shows it. */
export interface Closing {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  enrollmentNumber?: string;
  enrollmentDate: string;
  courseName: string;
  closedByName: string;
  teamName: string;
  totalFee: number;
  paidAmount: number;
  pendingAmount: number;
  feeStatus: string;
  status: string;
  /** Paid on it, but outside the period shown — never counted in it (2026-10-31). `paidAmount` is inside only. */
  paidOutside?: number;
  /** What the viewer may see of its commission: earned on what is collected, and the balance still to earn. */
  commission?: { earned: number; balance: number; state: string } | null;
}

export interface ClosingDay {
  date: string;
  count: number;
  totalFee: number;
  paidAmount: number;
  pendingAmount: number;
  enrolments: Closing[];
}

export interface ClosingsResponse {
  /** What the viewer may see (2026-10-31): everyone's, their teams', or their own. */
  view?: "all" | "team" | "own";
  /** A team leader's teams, for the team filter. */
  teams?: { id: string; name: string }[];
  days: ClosingDay[];
  totals: {
    days: number;
    count: number;
    totalFee: number;
    paidAmount: number;
    pendingAmount: number;
    commissionEarned?: number;
    commissionBalance?: number;
  };
  /** Always present, so a quiet morning reads "0" rather than showing nothing. */
  today: { date: string; count: number; totalFee: number };
  leaderboard: { name: string; count: number; totalFee: number }[];
}

export interface ClosingFilters {
  dateFrom?: string;
  dateTo?: string;
  team?: string;
  user?: string;
  mine?: boolean;
}

export const useDailyClosings = (filters: ClosingFilters) =>
  useQuery({
    queryKey: [...KEY, filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters.dateFrom) params.set("dateFrom", filters.dateFrom);
      if (filters.dateTo) params.set("dateTo", filters.dateTo);
      if (filters.team) params.set("team", filters.team);
      if (filters.user) params.set("user", filters.user);
      if (filters.mine) params.set("mine", "true");
      const res = await api.get<{ success: boolean; data: ClosingsResponse }>(
        `/students/closings/daily?${params.toString()}`,
      );
      return res.data.data;
    },
    // A closing book is watched during the day, so it keeps itself current.
    refetchInterval: 60_000,
  });
