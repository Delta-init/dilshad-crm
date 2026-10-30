"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/toast";
import api from "@/lib/axios";
import { API_URL } from "@/lib/apiUrl";
import { useAuthStore } from "@/lib/store/authStore";
import { leaveViewAsForSignOut } from "@/lib/impersonation";
import type { LoginFormValues } from "@/lib/validations/authSchema";
import type { ApiResponse, LoginResponse } from "@/types";

export const useLogin = () => {
  const { setAuth } = useAuthStore();
  const router = useRouter();

  return useMutation({
    mutationFn: async (data: LoginFormValues) => {
      const response = await api.post<ApiResponse<LoginResponse>>(
        "/auth/login",
        data,
      );
      return response.data.data!;
    },
    onSuccess: (data) => {
      setAuth(data.user, data.accessToken, data.refreshToken);
      toast.success("Welcome back!", {
        description: `Logged in as ${data.user.name}`,
      });
      router.push("/dashboard");
    },
    onError: (error: unknown) => {
      const message =
        (error as { response?: { data?: { message?: string } } })?.response
          ?.data?.message ?? "Login failed. Please check your credentials.";
      toast.error(message);
    },
  });
};

export const useLogout = () => {
  const { clearAuth } = useAuthStore();
  const router = useRouter();
  const queryClient = useQueryClient();

  return () => {
    // Signing out while viewing as someone ends that session, and the sign-out
    // below is recorded under the admin (their own token), not the person viewed.
    const ownToken = leaveViewAsForSignOut();
    // Put the sign-out on record while the token is still here. keepalive lets it
    // finish even as the page moves on; if it fails, signing out still happens.
    const token = ownToken ?? (typeof window !== "undefined" ? localStorage.getItem("accessToken") : null);
    if (token) {
      void fetch(`${API_URL}/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        keepalive: true,
      }).catch(() => undefined);
    }
    // clearAuth();
    toast.success("Logged out successfully");
    if (typeof window !== "undefined") {
      localStorage.removeItem("crm-auth");
      localStorage.removeItem("accessToken");
      localStorage.removeItem("refreshToken");
      queryClient.clear();
      
    }

    router.push("/login");
  };
};
