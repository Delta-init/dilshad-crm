import { z } from "zod";
import { DISPLAY_CURRENCIES } from "../utils/currencies.js";

export const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token is required"),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .regex(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,
      "Password must contain at least one uppercase letter, one lowercase letter, and one number"
    ),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

// PUT /auth/preferences — the signed-in person's own preferences: today, the currency they see amounts in. A pick that
// couldn't be saved at once is sent later with how long ago it was made (pickedAgoMs, by the device's own clock — so a
// clock set wrong doesn't matter); up to a year.
export const preferencesSchema = z
  .object({
    currency: z.enum(DISPLAY_CURRENCIES),
    pickedAgoMs: z.number().int().min(0).max(366 * 86_400_000).optional(),
  })
  .strict();
