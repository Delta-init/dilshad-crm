import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types/index.js";
import { UserService } from "../services/userService.js";
import { createUserSchema, updateUserSchema } from "../validations/userValidation.js";
import { sendSuccess, sendError } from "../utils/response.js";

const userService = new UserService();

export const createUser = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }

    const user = await userService.createUser(parsed.data);
    sendSuccess(res, "User created successfully", user, 201);
  } catch (error) {
    next(error);
  }
};

export const getUsers = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { users, pagination } = await userService.getUsers(req.query as Record<string, string>);
    sendSuccess(res, "Users retrieved successfully", users, 200, pagination);
  } catch (error) {
    next(error);
  }
};

/** GET /users/profile — returns the currently logged-in user */
export const getUserProfile = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = await userService.getUserById(req.user!.userId);
    sendSuccess(res, "User retrieved successfully", user);
  } catch (error) {
    next(error);
  }
};

/** GET /users/:id — returns any user by ID (requires users.view OR self-access) */
export const getUserById = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = await userService.getUserById(req.params.id);
    sendSuccess(res, "User retrieved successfully", user);
  } catch (error) {
    next(error);
  }
};

export const updateUser = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = updateUserSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }

    // Deactivating someone who still holds open leads (2026-11-10): transfer them first — the Users page asks where.
    if ((parsed.data as { status?: string }).status === "inactive") {
      const { User } = await import("../models/User.js");
      const current = await User.findById(req.params.id).select("name status").lean<{ name: string; status: string } | null>();
      if (current && current.status !== "inactive") {
        const { openLeadCount } = await import("../services/leadTransferService.js");
        const open = await openLeadCount(req.params.id);
        if (open > 0) {
          sendError(res, `${current.name} still has ${open} open lead${open === 1 ? "" : "s"} — transfer them first (Transfer leads)`, 409);
          return;
        }
      }
    }
    const user = await userService.updateUser(req.params.id, parsed.data);
    sendSuccess(res, "User updated successfully", user);
  } catch (error) {
    next(error);
  }
};

export const deleteUser = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await userService.deleteUser(req.params.id, req.user!.userId);
    sendSuccess(res, result.message);
  } catch (error) {
    next(error);
  }
};
