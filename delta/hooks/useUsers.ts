"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/lib/toast";
import api from "@/lib/axios";
import { beginViewAs, type ViewAsStart } from "@/lib/impersonation";
import type { ApiResponse, User } from "@/types";
import type { CreateUserFormValues, UpdateUserFormValues } from "@/lib/validations/userSchema";

const USERS_KEY = ["users"] as const;

export const useUsers = (params?: Record<string, string>) => {
  return useQuery({
    queryKey: [...USERS_KEY, params],
    queryFn: async () => {
      const response = await api.get<ApiResponse<User[]>>("/users", { params });
      return { data: response.data.data ?? [], pagination: response.data.pagination };
    },
  });
};

export const useUser = (id: string) => {
  return useQuery({
    queryKey: [...USERS_KEY, id],
    queryFn: async () => {
      const response = await api.get<ApiResponse<User>>(`/users/${id}`);
      return response.data.data!;
    },
    enabled: !!id,
  });
};

export const useCreateUser = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateUserFormValues) => {
      const response = await api.post<ApiResponse<User>>("/users", data);
      return response.data.data!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: USERS_KEY });
      toast.success("User created successfully");
    },
    onError: (error: unknown) => {
      const msg =
        (error as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        "Failed to create user";
      toast.error(msg);
    },
  });
};

export const useUpdateUser = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateUserFormValues }) => {
      const response = await api.put<ApiResponse<User>>(`/users/${id}`, data);
      return response.data.data!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: USERS_KEY });
      toast.success("User updated successfully");
    },
    onError: (error: unknown) => {
      const msg =
        (error as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        "Failed to update user";
      toast.error(msg);
    },
  });
};

/** "View as": the super admin signs in as this user for 30 minutes, read only (the page reloads). */
export const useImpersonate = () => {
  return useMutation({
    mutationFn: async (id: string) => {
      const response = await api.post<ApiResponse<ViewAsStart>>(`/users/${id}/impersonate`);
      return response.data.data!;
    },
    onSuccess: (data) => {
      if (!beginViewAs(data)) toast.error("Sign in again, then try View as — your own sign-in couldn't be kept aside");
    },
    onError: (error: unknown) => {
      const msg =
        (error as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        "Could not open the CRM as them";
      toast.error(msg);
    },
  });
};

export const useDeleteUser = () => {
  const queryClient = useQueryClient();
  return useMutation({
    // The server says what happened: deleted, or deactivated and kept for their history (2026-11-10).
    mutationFn: async (id: string) => (await api.delete<{ message?: string }>(`/users/${id}`)).data?.message ?? "User deleted successfully",
    onSuccess: (message: string) => {
      queryClient.invalidateQueries({ queryKey: USERS_KEY });
      toast.success(message);
    },
    onError: (error: unknown) => {
      const msg =
        (error as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        "Failed to delete user";
      toast.error(msg);
    },
  });
};
