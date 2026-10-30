import mongoose, { Schema } from "mongoose";
import { handOverOnAssign } from "./leadHandOver.js";
import { followUpDateOnStatus } from "./leadFollowUpDate.js";
import { ENROLMENT_PAYMENT_METHODS, type ILead, type ILeadNote, type IActivityLog, type IReminder, type IPayment, type IFollowUp } from "../types/index.js";

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
        "repeat_enquiry",
        "repeat_verified",
        "whatsapp_followup",
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
    /**
     * How it was paid and its receipt (the user, 2026-10-23: "the same as the
     * closing time — the payment upload"), asked whenever a payment is added
     * here. The close takes each one over as a payment of its own, method and
     * receipt filled in. Absent on payments from before.
     */
    method: { type: String, enum: ENROLMENT_PAYMENT_METHODS },
    receipt: {
      type: new Schema({
        name: { type: String },
        url: { type: String, required: true },
        key: { type: String, required: true },
        size: { type: Number },
        mimeType: { type: String },
        uploadedAt: { type: Date },
      }, { _id: false }),
      default: undefined,
    },
    /**
     * Sent to finance as a balance payment (the user, 2026-10-23): a payment
     * after the close only counts once finance has it — on the invoice, in the
     * LMS's access and in CS Portal's balance. `externalId` is the one
     * finance knows it by ("bp-…"); what became of it is asked of finance.
     */
    finance: {
      type: new Schema({
        externalId: { type: String, required: true },
        method: { type: String, required: true },
        sentAt: { type: Date, required: true },
        /** Finance's decision (2026-10-26): only an approved one counts. Absent on ones sent before — read as pending. */
        state: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
        decidedAt: { type: Date },
        reason: { type: String },
      }, { _id: false }),
      default: undefined,
    },
    /**
     * "INR" when the amount is rupees: a balance payment on a Bangalore enrolment, sent in its invoice's currency
     * (2026-10-28). Absent: AED, as every other lead payment.
     */
    currency: { type: String, enum: ["INR"] },
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
    // The same number coming in again from the ads (2026-10-23, services/repeatLeadService.ts): counted, and held by
    // its team leader until they verify it and give it to the same person or another in the team.
    repeatCount: { type: Number, default: 0, min: 0 },
    repeat: {
      type: new Schema(
        {
          waiting: { type: Boolean, default: false },
          at: { type: Date, required: true },
          team: { type: Schema.Types.ObjectId, ref: "Team", default: null },
          previousOwner: { type: Schema.Types.ObjectId, ref: "User", default: null },
          previousStatus: { type: String, default: null },
          alreadyClient: { type: Boolean, default: false },
          holder: { type: Schema.Types.ObjectId, ref: "User", default: null },
          source: { type: String, default: null },
          campaign: { type: String, default: null },
          decidedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
          decidedAt: { type: Date, default: null },
          givenTo: { type: Schema.Types.ObjectId, ref: "User", default: null },
        },
        { _id: false },
      ),
      default: null,
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
    // Automatic WhatsApp follow-ups stopped on this lead (services/whatsapp/followups.ts): until someone writes to them
    // on WhatsApp again, which starts a new chain.
    waFollowupStoppedAt: { type: Date, default: null },
    waFollowupStoppedByName: { type: String, default: "" },
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
leadSchema.index({ "repeat.waiting": 1, "repeat.team": 1 }, { partialFilterExpression: { "repeat.waiting": true } });
leadSchema.index({ reporter: 1 });
leadSchema.index({ createdAt: -1 });
leadSchema.index({ nextFollowUpAt: 1 });
// Inactive leads: untouched statuses, oldest assignment first
leadSchema.index({ status: 1, assignedAt: 1 });
// Reminders (2026-10-30, "the CRM is too slow"): each person's reminders, the badge's count and the scheduler's due /
// warning passes every 30 s were reading every lead; and the 2-minute finance check on balance payments too.
leadSchema.index({ "reminders.createdBy": 1 });
leadSchema.index({ "reminders.isDone": 1, "reminders.remindAt": 1 });
leadSchema.index({ "payments.finance.externalId": 1 }, { sparse: true });

handOverOnAssign(leadSchema);
// After the hand-over, so a status it sets clears an old follow-up date too.
followUpDateOnStatus(leadSchema);

export const Lead = mongoose.model<ILead>("Lead", leadSchema);
