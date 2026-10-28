import mongoose, { Schema } from "mongoose";
import type { IAppSettings } from "../types/index.js";

/**
 * The CRM's own settings — one document, keyed "app".
 *
 * Everything the Settings page's "Automation & alerts" section edits: when an
 * untouched lead counts as inactive and whether it moves on, when an idle
 * employee is flagged, the working hours both of those count in, and which
 * events also send email. Read through settingsService, which caches it for
 * the schedulers that ask every minute.
 */
const appSettingSchema = new Schema<IAppSettings>(
  {
    key: { type: String, enum: ["app"], default: "app", unique: true },

    inactiveLeads: {
      autoReassign: { type: Boolean, default: false },
      limitMinutes: { type: Number, default: 45, min: 5, max: 7 * 24 * 60 },
      // Stamped by the server when automatic moves are switched on, cleared when off
      enabledAt:    { type: Date, default: null },
    },

    idleAlerts: {
      enabled:           { type: Boolean, default: false },
      limitMinutes:      { type: Number, default: 30, min: 5, max: 24 * 60 },
      notifyTeamLeaders: { type: Boolean, default: false },
    },

    // The rate a Bangalore enrolment's rupees count in the revenue figures at: 1 AED = this many (the user, 2026-10-28)
    bangaloreRevenue: {
      inrPerAed: { type: Number, default: 22.75, min: 1, max: 1000 },
    },

    workingHours: {
      timezone: { type: String, default: "Asia/Dubai" },
      days:     { type: [Number], default: [1, 2, 3, 4, 5, 6] },
      start:    { type: String, default: "09:00" },
      end:      { type: String, default: "18:00" },
    },

    email: {
      inactiveLeads: { type: Boolean, default: true },
      idleAlerts:    { type: Boolean, default: true },
      meetings:      { type: Boolean, default: true },
    },

    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true, versionKey: false }
);

export const AppSetting = mongoose.model<IAppSettings>("AppSetting", appSettingSchema);
