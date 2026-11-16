import type { Response, NextFunction } from "express";
import { Types } from "mongoose";
import type { AuthenticatedRequest, CrmModule, PermissionAction } from "../types/index.js";
import { Team } from "../models/Team.js";
import { sendError } from "../utils/response.js";

/**
 * Middleware factory that checks if the authenticated user's role
 * has the required permission for a given module.
 */
export const checkPermission = (module: CrmModule, action: PermissionAction) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const role = req.user?.role;

    if (!role) {
      sendError(res, "Role information missing", 403);
      return;
    }

    // Super Admin role has unrestricted access
    if (role.isSystemRole && role.roleName === "Super Admin") {
      next();
      return;
    }

    const modulePerms = role.permissions?.[module];

    if (!modulePerms) {
      sendError(res, `Access denied: no permissions defined for module '${module}'`, 403);
      return;
    }

    if (!modulePerms[action]) {
      sendError(
        res,
        `Access denied: you do not have '${action}' permission on '${module}'`,
        403
      );
      return;
    }

    next();
  };
};

/**
 * Middleware that lets through a role holding any one of several permissions —
 * for a route two screens share, each gated its own way.
 */
export const checkAnyPermission = (...grants: [CrmModule, PermissionAction][]) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const role = req.user?.role;
    if (!role) {
      sendError(res, "Role information missing", 403);
      return;
    }
    if (role.isSystemRole && role.roleName === "Super Admin") {
      next();
      return;
    }
    if (grants.some(([module, action]) => role.permissions?.[module]?.[action])) {
      next();
      return;
    }
    sendError(
      res,
      `Access denied: you need ${grants.map(([module, action]) => `'${action}' on '${module}'`).join(" or ")}`,
      403,
    );
  };
};

/**
 * Middleware that checks if the user has any permission on a given module.
 * Useful for protecting entire resource routes.
 */
export const requireModule = (module: CrmModule) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const role = req.user?.role;

    if (!role) {
      sendError(res, "Role information missing", 403);
      return;
    }

    if (role.isSystemRole && role.roleName === "Super Admin") {
      next();
      return;
    }

    const modulePerms = role.permissions?.[module];
    const hasAnyAccess =
      modulePerms &&
      Object.values(modulePerms).some(Boolean);

    if (!hasAnyAccess) {
      sendError(res, `Access denied: no access to module '${module}'`, 403);
      return;
    }

    next();
  };
};

/**
 * Only the Super Admin — for screens that are theirs alone, like Inactive
 * leads. Not a module a role can be granted: the whole point is that nobody
 * else decides whose leads move.
 */
export const requireSuperAdmin = (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
  const role = req.user?.role;
  if (role?.isSystemRole && role.roleName === "Super Admin") {
    next();
    return;
  }
  sendError(res, "Access denied: only a super admin can do this", 403);
};

/**
 * One person's own data — their leads, lead stats, revenue — for them, or for
 * someone who may see them: a super admin or reporter, a role allowed to view
 * users (the Users page), or their team leader. Anyone else is refused.
 */
export const selfOrOverseer = (param = "userId") => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const target = req.params[param];
      const me = req.user?.userId;
      const role = req.user?.role;
      if (!me || !role) {
        sendError(res, "Role information missing", 403);
        return;
      }
      if (target === me) return next();
      if ((role.isSystemRole && role.roleName === "Super Admin") || role.roleName === "Reporter" || role.permissions?.users?.view) {
        return next();
      }
      if (
        Types.ObjectId.isValid(target) &&
        (await Team.exists({ leaders: new Types.ObjectId(me), $or: [{ members: new Types.ObjectId(target) }, { leaders: new Types.ObjectId(target) }] }))
      ) {
        return next();
      }
      sendError(res, "Access denied: you can only see your own leads", 403);
    } catch (err) {
      next(err);
    }
  };
};

