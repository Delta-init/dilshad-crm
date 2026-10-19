import mongoose, { Schema } from "mongoose";
import { handOverOnAssign } from "./leadHandOver.js";
import { followUpDateOnStatus } from "./leadFollowUpDate.js";
import type { ILead, ILeadNote, IActivityLog, IReminder, IPayment, IFollowUp } from "../types/index.js";

// ─── Note Sub-Schema ──────────────────────────────────────────────────────────
const leadNoteSchema = new Schema<ILeadNote & { createdAt: Date; updatedAt: Date }>(
  {
    content: {
      type: String,
      required: [true, "Note content is required"],
      trim: true,
      maxlength: [2000, "Note cannot exceed 2000 characters"],
    },
    author: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Note author is required"],
    },
  },
  {
    timestamps: true,
    _id: true,
  }
);

// ─── Activity Log Sub-Schema ──────────────────────────────────────────────────
const activityLogSchema = new Schema<IActivityLog>(
  {
    action: {
      type: String,
      required: true,
      enum: [
        "lead_created",
        "lead_updated",
        "status_changed",
        "lead_assigned",
        "team_assigned",
        "note_added",
        "note_updated",
        "note_deleted",
        "whatsapp_welcome",
        "followup_missed",
        "inactive_reassigned",
      ],
    },
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: [500, "Description cannot exceed 500 characters"],
    },
    // Left out when the CRM did it on its own (a lead moved on for inactivity) —
    // every screen that lists activity already shows those as "System".
    performedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    changes: {
      type: Schema.Types.Mixed,
      default: undefined,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true, timestamps: false }
);

// ─── Reminder Sub-Schema ──────────────────────────────────────────────────────
const reminderSchema = new Schema<IReminder>(
  {
    title: {
      type: String,
      trim: true,
      maxlength: [200, "Title cannot exceed 200 characters"],
    },
    note: {
      type: String,
      trim: true,
      maxlength: [1000, "Note cannot exceed 1000 characters"],
    },
    remindAt: {
      type: Date,
      required: [true, "Reminder date/time is required"],
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    isDone: {
      type: Boolean,
      default: false,
    },
    // Stamped by the server scheduler once the on-time push is sent
    notifiedAt: {
      type: Date,
      default: null,
    },
    // Stamped by the server scheduler once the 30-min warning push is sent
    warnedAt: {
      type: Date,
      default: null,
    },
  },
  { _id: true, timestamps: true }
);

// ─── Payment Sub-Schema ───────────────────────────────────────────────────────
const paymentSchema = new Schema<IPayment>(
  {
    amount: {
      type: Number,
      required: [true, "Payment amount is required"],
      min: [0, "Amount cannot be negative"],
    },
    note: {
      type: String,
      trim: true,
      maxlength: [500, "Note cannot exceed 500 characters"],
    },
    paidAt: {
      type: Date,
      required: [true, "Payment date is required"],
      default: Date.now,
    },
    addedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { _id: true, timestamps: true }
);

// ─── Follow-Up Sub-Schema ─────────────────────────────────────────────────────
const followUpSchema = new Schema<IFollowUp>(
  {
    note: {
      type: String,
      trim: true,
      maxlength: [1000, "Follow-up note cannot exceed 1000 characters"],
    },
    followedUpAt: {
      type: Date,
      required: [true, "Follow-up date/time is required"],
      default: Date.now,
    },
    followedUpBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    nextFollowUpAt: {
      type: Date,
      default: null,
    },
  },
  { _id: true, timestamps: true }
);

// ─── Lead Schema ──────────────────────────────────────────────────────────────
const leadSchema = new Schema<ILead>(
  {
    name: {
      type: String,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, "Please provide a valid email"],
    },
    phone: {
      type: String,
      required: [true, "Phone is required"],
      trim: true,
    },
    hasWhatsapp: {
      type: Boolean,
      default: true,
    },
    source: {
      type: String,
      trim: true,
      maxlength: [100, "Source cannot exceed 100 characters"],
    },
    course: {
      type: Schema.Types.ObjectId,
      ref: "Course",
      default: null,
    },
    status: {
      type: String,
      // meeting_scheduled is set only through PATCH /leads/:id/status, which needs the meeting time and sets its reminder
      enum: ["new", "assigned", "pending_response", "followup", "meeting_scheduled", "meeting_done", "closed", "lost", "not_connected", "wrong_number", "mia", "repeated", "callback", "cnc"],
      default: "new",
    },
    lostReason: {
      type: String,
      enum: ["price_too_high", "not_interested", "competitor", "unresponsive", "budget_issue", "wrong_timing", "other"],
      default: null,
    },
    lostNotes: {
      type: String,
      default: null,
      trim: true,
    },
    assignedTo: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    assignedAt: {
      type: Date,
      default: null,
    },
    // Declared so it can change: a lead handed to someone takes the hand-over
    // time as its created date (see leadHandOver.ts). Still set on create by timestamps.
    createdAt: { type: Date },
    // The first created date, kept once when the lead is first handed over.
    originalCreatedAt: { type: Date, default: undefined },
    team: {
      type: Schema.Types.ObjectId,
      ref: "Team",
      default: null,
    },
    reporter: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Reporter is required"],
    },
    notes: {
      type: [leadNoteSchema],
      default: [],
    },
    reminders: {
      type: [reminderSchema],
      default: [],
    },
    payments: {
      type: [paymentSchema],
      default: [],
    },
    activityLogs: {
      type: [activityLogSchema],
      default: [],
    },
    followUps: {
      type: [followUpSchema],
      default: [],
    },
    nextFollowUpAt: {
      type: Date,
      default: null,
    },
    platform: {
      type: String,
      trim: true,
      maxlength: [50, "Platform cannot exceed 50 characters"],
    },
    campaign: {
      type: String,
      trim: true,
      maxlength: [200, "Campaign cannot exceed 200 characters"],
    },
    // The lead's calls through 3CX (since 2026-10-14): counted by the call sync from lead_calls
    // (callSyncService.recountLeadCalls) — every call, the connected ones, and the missed + not answered ones.
    // Not edited by hand any more: the counters' PATCH routes and the lead form leave them alone.
    callNotConnected: {
      type: Number,
      default: 0,
      min: [0, "Call not connected count cannot be negative"],
    },
    callCount: {
      type: Number,
      default: 0,
      min: [0, "Call count cannot be negative"],
    },
    callConnected: {
      type: Number,
      default: 0,
      min: [0, "Connected call count cannot be negative"],
    },
    firstContactTime: {
      type: Date,
      default: null,
    },
    initialLeadResponse: {
      type: String,
      enum: ["very_interested", "not_interested", "let_me_think", null],
      default: null,
    },
    primaryConcern: {
      type: String,
      enum: ["risk", "price", "time", "trust", "exact_concern", null],
      default: null,
    },
    followupStrategyType: {
      type: String,
      enum: ["risk_based", "price_based", "time_based", "trust_based", null],
      default: null,
    },
    sellingAmount: {
      type: Number,
      default: null,
      min: [0, "Selling amount cannot be negative"],
    },
    // ─── Legacy import fields ──────────────────────────────────────────────────
    leadReceivedTime: {
      type: String,
      trim: true,
      maxlength: [50, "Lead received time cannot exceed 50 characters"],
      default: null,
    },
    exactConcern: {
      type: String,
      trim: true,
      maxlength: [1000, "Exact concern cannot exceed 1000 characters"],
      default: null,
    },
    demoScheduled: {
      type: Boolean,
      default: null,
    },
    demoAttended: {
      type: Boolean,
      default: null,
    },
    lastFollowupDate: {
      type: Date,
      default: null,
    },
    lastContactedAt: {
      type: Date,
      default: null,
    },
    // Stamped when a missed-follow-up warning was sent for the current nextFollowUpAt
    missedFollowUpWarnedAt: {
      type: Date,
      default: null,
    },
    referralType: {
      type: String,
      enum: ["employee", "external", "student", null],
      default: null,
    },
    referredBy: {
      type: String,
      trim: true,
      maxlength: [100, "Referred by cannot exceed 100 characters"],
      default: null,
    },
    // Outcome of the automatic WhatsApp welcome message (sent once on creation)
    whatsappWelcome: {
      type: new Schema(
        {
          status: { type: String, enum: ["sent", "failed", "skipped"] },
          messageId: { type: String, default: null },
          error: { type: String, default: null },
          sentAt: { type: Date, default: null },
        },
        { _id: false },
      ),
      default: null,
    },
    comments: {
      type: String,
      trim: true,
      maxlength: [2000, "Comments cannot exceed 2000 characters"],
      default: null,
    },
    // Moves for inactivity (Settings → Automation & alerts). Absent until the first one.
    inactivity: {
      type: new Schema(
        {
          // Everyone who lost this lead for not acting on it — never moved back to them automatically
          lostBy: [{ type: Schema.Types.ObjectId, ref: "User" }],
          moves: { type: Number, default: 0 },
          lastMovedAt: { type: Date, default: null },
          // Nobody left in the team to move it to, for the current assignment — left for a super admin
          stuckAt: { type: Date, default: null },
        },
        { _id: false },
      ),
      default: undefined,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

leadSchema.index({ course: 1 });

// Sparse unique index on email (allows multiple nulls)
leadSchema.index({ email: 1 });
leadSchema.index({ status: 1 });
leadSchema.index({ assignedTo: 1 });
leadSchema.index({ team: 1 });
leadSchema.index({ reporter: 1 });
leadSchema.index({ createdAt: -1 });
leadSchema.index({ nextFollowUpAt: 1 });
// Inactive leads: untouched statuses, oldest assignment first
leadSchema.index({ status: 1, assignedAt: 1 });

handOverOnAssign(leadSchema);
// After the hand-over, so a status it sets clears an old follow-up date too.
followUpDateOnStatus(leadSchema);

export const Lead = mongoose.model<ILead>("Lead", leadSchema);
