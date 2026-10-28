import type { Response, NextFunction } from "express";
import { z } from "zod";
import * as XLSX from "xlsx";
import { ENROLMENT_PAYMENT_METHODS, type AuthenticatedRequest, type IRole } from "../types/index.js";
import { LeadService, autoSplitLeadPublic } from "../services/leadService.js";
import { sendWelcomeToLead } from "../services/whatsappCloudService.js";
import { ExcelService } from "../services/excelService.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { sendPushToUser } from "../services/pushService.js";
import { emitToUser } from "../socket.js";
import { Lead } from "../models/Lead.js";
import { User } from "../models/User.js";
import { Team } from "../models/Team.js";
import mongoose from "mongoose";
import { notifyLeadAssignment } from "../services/pushService.js";
import { announceNewLeads, collectAssignments } from "../services/leadAlertService.js";
import { holdRepeatLead, announceRepeats, findLeadByPhone, repeatMessage, type RepeatOutcome } from "../services/repeatLeadService.js";
import { changeFollowUpDate, syncFollowUpDateWithReminder } from "../services/followUpDateService.js";
import { closeIsInFinance, leadFinanceLink, sendLeadPayment } from "../services/leadFinancePaymentService.js";
import { COUNTED_PAYMENT } from "../utils/countedPayments.js";

const leadService = new LeadService();
const excelService = new ExcelService();

// ─── Validation Schemas ───────────────────────────────────────────────────────

const isReferralSource = (s?: string | null) =>
  !!s && s.toLowerCase().includes("referral");

const createLeadSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  email: z.string().email("Invalid email").optional().or(z.literal("")),
  phone: z.string().min(1, "Phone is required").max(20),
  hasWhatsapp: z.boolean().optional(),
  // Required for a lead created here; uploads and the sheet sync have their own routes
  source: z.string({ error: "Source is required" }).trim().min(1, "Source is required").max(100),
  course: z.string().optional().nullable(),
  status: z
    // Not meeting_scheduled: that needs a meeting time, so only PATCH /leads/:id/status sets it
    .enum(["new", "assigned", "pending_response", "followup", "meeting_done", "closed", "lost", "not_connected", "wrong_number", "mia", "repeated", "callback", "cnc"])
    .optional(),
  team: z.string().optional().nullable(),
  assignedTo: z.string().optional(),
  referralType: z.enum(["employee", "external", "student"]).optional().nullable(),
  referredBy: z.string().max(100).optional().nullable(),
}).superRefine((data, ctx) => {
  if (isReferralSource(data.source) && !data.referredBy?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["referredBy"],
      message: "Referred By is mandatory for referral leads",
    });
  }
});

const updateLeadSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  email: z
    .string()
    .email("Invalid email")
    .optional()
    .or(z.literal(""))
    .nullable(),
  phone: z.string().min(1).max(20).optional(),
  source: z.string().max(100).optional().nullable(),
  course: z.string().optional().nullable(),
  status: z
    // Not meeting_scheduled: that needs a meeting time, so only PATCH /leads/:id/status sets it
    .enum(["new", "assigned", "pending_response", "followup", "meeting_done", "closed", "lost", "not_connected", "wrong_number", "mia", "repeated", "callback", "cnc"])
    .optional(),
  assignedTo: z.string().optional().nullable(),
  initialLeadResponse: z.string().optional().nullable(),
  primaryConcern: z.string().optional().nullable(),
  followUpStrategy: z.string().optional().nullable(),
  lastFollowupDate: z.string().optional().nullable(),
  firstContactTime: z.string().optional().nullable(),
  demoScheduled: z.boolean().optional().nullable(),
  demoAttended: z.boolean().optional().nullable(),
  hasWhatsapp: z.boolean().optional().nullable(),
  sellingAmount: z.number().optional().nullable(),
  followupStrategyType: z.string().optional().nullable(),
  exactConcern: z.string().max(1000).optional().nullable(),
  comments: z.string().max(2000).optional().nullable(),
  referralType: z.enum(["employee", "external", "student"]).optional().nullable(),
  referredBy: z.string().max(100).optional().nullable(),
});

const LOST_REASONS = ["price_too_high", "not_interested", "competitor", "unresponsive", "budget_issue", "wrong_timing", "other"] as const;

/** A meeting may be booked a few minutes late (clocks drift) but not for a time already gone. */
const MEETING_PAST_GRACE_MS = 5 * 60_000;

const updateStatusSchema = z.object({
  status: z.enum(["new", "assigned", "pending_response", "followup", "meeting_scheduled", "meeting_done", "closed", "lost", "not_connected", "wrong_number", "mia", "repeated", "callback", "cnc"]),
  lostReason: z.enum(LOST_REASONS).optional(),
  lostNotes:  z.string().max(500).optional(),
  // Mandatory when status → followup (details + when it happened)
  followUpNote:   z.string().max(2000).optional(),
  followUpAt:     z.string().optional(),
  nextFollowUpAt: z.string().optional().nullable(),
  // Mandatory when status → meeting_scheduled: when the meeting is (it becomes a reminder)
  meetingAt:   z.string().optional(),
  meetingNote: z.string().max(500).optional(),
}).superRefine((data, ctx) => {
  if (data.status === "meeting_scheduled") {
    const at = data.meetingAt ? new Date(data.meetingAt) : null;
    if (!at || isNaN(at.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["meetingAt"], message: "Meeting date & time is required when status is meeting scheduled" });
    } else if (at.getTime() < Date.now() - MEETING_PAST_GRACE_MS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["meetingAt"], message: "The meeting time has already passed" });
    }
  }
  if (data.status === "lost" && !data.lostReason) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lostReason"], message: "Lost reason is required when status is lost" });
  }
  if (data.status === "lost" && !data.lostNotes?.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lostNotes"], message: "Notes are required when marking a lead as lost" });
  }
  if (data.status === "followup") {
    if (!data.followUpNote?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["followUpNote"], message: "Follow-up details are required when status is followup" });
    }
    if (!data.followUpAt || isNaN(new Date(data.followUpAt).getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["followUpAt"], message: "Follow-up date & time is required when status is followup" });
    }
  }
});

const assignLeadSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
});

const autoAssignSchema = z.object({
  leadIds: z.array(z.string()).optional(),
  teamIds: z.array(z.string()).optional(),
});

const noteSchema = z.object({
  content: z.string().min(1, "Note content is required").max(2000),
});

// ─── Lead Controllers ─────────────────────────────────────────────────────────

export const uploadLeads = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const file = req.file;
    if (!file) {
      sendError(res, "No file uploaded", 400);
      return;
    }

    const allowedMimetypes = [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
      "text/csv",
      "application/csv",
    ];
    if (
      !allowedMimetypes.includes(file.mimetype) &&
      !file.originalname.match(/\.(xlsx|xls|csv)$/i)
    ) {
      sendError(
        res,
        "Invalid file type. Please upload an xlsx, xls, or csv file.",
        400,
      );
      return;
    }

    const parseResult = await excelService.parseFile(
      file.buffer,
      file.mimetype,
    );

    const repeatsFound = parseResult.repeats ?? [];
    if (parseResult.valid.length === 0 && repeatsFound.length === 0 && parseResult.invalid.length > 0) {
      sendError(res, "No valid leads found in the file", 400, {
        invalid: parseResult.invalid,
      });
      return;
    }

    const reporterId = req.user!.userId;

    // Numbers already in the CRM: those leads came in again — held for their team leaders to verify, as from the sheet,
    // never created twice (2026-10-23).
    const repeatDetails: { row: number; phone: string; leadId: string; outcome: string; message: string }[] = [];
    const heldInUpload: Array<Extract<RepeatOutcome, { kind: "held" }>> = [];
    const repeatsToSplit: string[] = [];
    for (const r of repeatsFound) {
      try {
        const out = await holdRepeatLead(r.leadId, { name: r.name, source: r.source ?? null, note: `In an upload (row ${r.row})` }, reporterId);
        if (out.kind === "held") heldInUpload.push(out); else repeatsToSplit.push(out.leadId);
        repeatDetails.push({ row: r.row, phone: r.phone, leadId: r.leadId, outcome: out.kind, message: repeatMessage(out) });
      } catch (err) {
        console.error("[upload] repeat not held:", err instanceof Error ? err.message : err);
      }
    }
    if (heldInUpload.length) void announceRepeats(heldInUpload);
    if (repeatsToSplit.length) await leadService.autoAssignLeads(repeatsToSplit).catch(() => null);
    let createdLeads: unknown[] = [];

    if (parseResult.valid.length > 0) {
      createdLeads = await leadService.bulkCreateLeads(
        parseResult.valid,
        reporterId,
      );
    }

    // teamIds may arrive as a JSON string in the multipart form body
    let teamIds: string[] | undefined;
    try {
      if (req.body.teamIds) {
        const parsed = JSON.parse(req.body.teamIds as string);
        if (Array.isArray(parsed)) teamIds = parsed.filter((id) => typeof id === "string");
      }
    } catch {
      // malformed — treat as "all teams"
    }

    // Parse per-team member overrides — { teamId: string[] }
    let memberOverrides: Record<string, string[]> | undefined;
    try {
      if (req.body.memberOverrides) {
        const parsed = JSON.parse(req.body.memberOverrides as string);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          memberOverrides = parsed as Record<string, string[]>;
        }
      }
    } catch {
      // malformed — ignore, fall back to team defaults
    }

    let assignmentResult = {
      assigned: 0,
      results: [] as { leadId: string; assignedTo: string }[],
    };
    if (createdLeads.length > 0) {
      try {
        const leadIds = (
          createdLeads as Array<{ _id: { toString(): string } }>
        ).map((l) => l._id.toString());
        assignmentResult = await leadService.autoAssignLeads(leadIds, teamIds, memberOverrides);
      } catch {
        // Auto-assign failure should not block the upload
      }
    }

    // The team leaders, Super Admins and the Sales Manager: one notice for the upload (2026-10-19).
    void announceNewLeads(
      (createdLeads as Array<{ _id: { toString(): string } }>).map((l) => l._id.toString()),
      { by: reporterId },
    );

    sendSuccess(
      res,
      "Leads uploaded successfully",
      {
        total: parseResult.valid.length + parseResult.invalid.length + repeatsFound.length,
        created: createdLeads.length,
        assigned: assignmentResult.assigned,
        invalid: parseResult.invalid.length,
        invalidDetails: parseResult.invalid,
        cameAgain: repeatDetails.length,
        repeatDetails,
      },
      201,
    );
  } catch (error) {
    next(error);
  }
};

// ─── Legacy Upload (Old Leads sheet format) ───────────────────────────────────

/** Map sheet "Lead status" text → CRM status enum */
function mapLegacyStatus(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (v.includes("pending") || v.includes("pending_response"))  return "pending_response";
  if (v.includes("follow"))                                      return "followup";
  if (v.includes("not connect") || v === "not_connected")        return "not_connected";
  if (v.includes("wrong"))                                       return "wrong_number";
  if (v.includes("meeting") && v.includes("done"))               return "meeting_done";
  if (v === "closed" || v === "close")                           return "closed";
  if (v === "lost")                                              return "lost";
  if (v === "repeated" || v === "repeat")                        return "repeated";
  if (v === "cnc")                                               return "cnc";
  if (v === "callback")                                          return "callback";
  if (v === "mia")                                               return "mia";
  return "new";
}

/** Map "Lead Source" text → CRM source string */
function mapLegacySource(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (v === "abhin") return "meta - abhin leads";
  if (v === "shoaib" || v === "shuhaib") return "meta - shuhaib leads";
  if (v === "google") return "google";
  if (v === "meta" || v === "fb" || v === "facebook") return "meta";
  if (v === "whatsapp" || v === "wa") return "whatsapp";
  return raw.trim().toLowerCase() || "other";
}

/** Map "Initial Lead Response" → CRM enum */
function mapInitialResponse(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (v.includes("let me think") || v === "let_me_think") return "let_me_think";
  if (v.includes("very interested") || v === "very_interested") return "very_interested";
  if (v.includes("not interested") || v === "not_interested") return "not_interested";
  return null;
}

/** Map "Primary Concern" → CRM enum */
function mapPrimaryConcern(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (v === "risk") return "risk";
  if (v === "price") return "price";
  if (v === "time") return "time";
  if (v === "trust") return "trust";
  if (v === "exact_concern" || v.includes("exact")) return "exact_concern";
  return null;
}

/** Map "Follow-up Strategy Type" → CRM enum */
function mapFollowupStrategy(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (v.includes("risk")) return "risk_based";
  if (v.includes("price")) return "price_based";
  if (v.includes("time")) return "time_based";
  if (v.includes("trust")) return "trust_based";
  return null;
}

/** Sanitize email — return undefined if invalid */
function sanitizeLegacyEmail(raw?: string): string | undefined {
  const e = (raw ?? "").trim().toLowerCase();
  if (!e) return undefined;
  return /^\S+@\S+\.\S+$/.test(e) ? e : undefined;
}

/** Parse an Excel serial date or date string into a JS Date */
function parseLegacyDate(raw: unknown): Date | null {
  if (!raw) return null;

  // Native Date object (e.g. from cellDates:true)
  if (raw instanceof Date) {
    return isNaN(raw.getTime()) ? null : raw;
  }

  // Excel serial number
  if (typeof raw === "number") {
    const d = XLSX.SSF.parse_date_code(raw);
    if (d) return new Date(Date.UTC(d.y, d.m - 1, d.d));
  }

  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return null;

    // DD-MM-YYYY or DD/MM/YYYY  (sheet format — always treat as day-first)
    const dmyMatch = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (dmyMatch) {
      const day   = parseInt(dmyMatch[1], 10);
      const month = parseInt(dmyMatch[2], 10);
      const year  = parseInt(dmyMatch[3], 10);
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        return new Date(Date.UTC(year, month - 1, day));
      }
    }

    // YYYY-MM-DD (ISO — safe to pass to Date directly)
    const isoMatch = s.match(/^\d{4}-\d{2}-\d{2}/);
    if (isoMatch) {
      const d = new Date(s);
      return isNaN(d.getTime()) ? null : d;
    }
  }

  return null;
}

/** Build a structured note from all overflow fields */
function buildLegacyNote(row: Record<string, string>, source: string): string {
  const lines: string[] = [
    `📋 Lead Import — ${source}`,
    "─────────────────────────────",
  ];

  if (row.receivedTime) lines.push(`📅 Lead Received: ${row.receivedTime}`);
  if (row.firstContact) lines.push(`🕐 First Contact: ${row.firstContact}`);

  if (row.exactConcern) {
    lines.push("");
    lines.push("💭 Exact Concern");
    lines.push("─────────────────────────────");
    lines.push(row.exactConcern);
  }

  const hasFollowup = row.followupInterval || row.lastFollowup;
  if (hasFollowup) {
    lines.push("");
    lines.push("📋 Follow-up Details");
    lines.push("─────────────────────────────");
    if (row.followupInterval) lines.push(`Follow-up Interval: ${row.followupInterval} days`);
    if (row.lastFollowup) lines.push(`Last Follow-up: ${row.lastFollowup}`);
  }

  const hasDemo = row.demoScheduled || row.demoAttended;
  if (hasDemo) {
    lines.push("");
    lines.push("🎯 Demo");
    lines.push("─────────────────────────────");
    if (row.demoScheduled) lines.push(`Demo Scheduled: ${row.demoScheduled}`);
    if (row.demoAttended) lines.push(`Demo Attended: ${row.demoAttended}`);
  }

  if (row.comments) {
    lines.push("");
    lines.push("💬 Comments");
    lines.push("─────────────────────────────");
    lines.push(row.comments);
  }

  if (row.priceOrCampaign) {
    lines.push("");
    lines.push("📊 Additional Info");
    lines.push("─────────────────────────────");
    lines.push(row.priceOrCampaign);
  }

  if (row.campaign) {
    lines.push(`Campaign: ${row.campaign}`);
  }

  return lines.join("\n");
}

export const uploadLegacyLeads = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const file = req.file;
    if (!file) { sendError(res, "No file uploaded", 400); return; }

    // ── Parse workbook ──────────────────────────────────────────────────────
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(file.buffer, { type: "buffer", cellDates: true });
    } catch {
      sendError(res, "Failed to parse file. Ensure it is a valid .xlsx file.", 400);
      return;
    }

    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    // sheet_to_json with header:1 gives raw array of arrays
    const allRows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

    // Find the header row (the one that contains "Lead Name" or "Phone Number")
    let headerRowIdx = -1;
    for (let i = 0; i < Math.min(5, allRows.length); i++) {
      const row = allRows[i] as string[];
      if (row.some((c) => typeof c === "string" && (c.includes("Lead Name") || c.includes("Phone Number")))) {
        headerRowIdx = i;
        break;
      }
    }

    if (headerRowIdx === -1) {
      sendError(res, "Could not find header row. Ensure the sheet has 'Lead Name' and 'Phone Number' columns.", 400);
      return;
    }

    const rawHeaders = (allRows[headerRowIdx] as string[]).map((h) => String(h ?? "").trim());
    const dataRows = allRows.slice(headerRowIdx + 1);

    // Column index helpers
    const col = (name: string) => rawHeaders.findIndex((h) => h.toLowerCase() === name.toLowerCase());
    const colPartial = (part: string) => rawHeaders.findIndex((h) => h.toLowerCase().includes(part.toLowerCase()));

    const idxName       = col("Lead Name");
    const idxPhone      = col("Phone Number");
    const idxDate       = col("Date");
    const idxSource     = col("Lead Source");
    const idxStatus     = col("Lead status");
    const idxReceived   = col("Lead Received Time");
    const idxFirstContact = col("First Contact Time");
    const idxResponse   = col("Initial Lead Response");
    const idxConcern    = col("Primary Concern");
    const idxExact      = colPartial("Exact Concern");
    const idxDemoSched  = col("Demo Scheduled");
    const idxDemoAtten  = colPartial("Demo Attended");
    const idxFollowupType = col("Follow-up Strategy Type");
    const idxLastFollowup = col("Last Follow-up Date");
    const idxComments   = colPartial("Comments");
    const idxPriceCamp  = rawHeaders.length > 16 ? 16 : -1; // Unnamed: 16
    const idxCampaigns  = col("CAMPAIGNS");

    if (idxName === -1 || idxPhone === -1) {
      sendError(res, "Missing required columns: 'Lead Name' and 'Phone Number'", 400);
      return;
    }

    // ── Reporter ────────────────────────────────────────────────────────────
    const reporterId = req.user!.userId;

    // ── Source override from body ───────────────────────────────────────────
    const sourceOverride = typeof req.body.sourceOverride === "string" && req.body.sourceOverride.trim()
      ? req.body.sourceOverride.trim()
      : null;

    // ── Direct assign override ──────────────────────────────────────────────
    const assignedToId = typeof req.body.assignedTo === "string" && req.body.assignedTo.trim()
      ? req.body.assignedTo.trim()
      : null;
    const assignedUser = assignedToId
      ? await User.findById(assignedToId).select("_id").lean()
      : null;

    // Look up the assigned user's team once — set on every created lead
    const assignedTeam = assignedUser
      ? await Team.findOne({
          $or: [{ members: assignedUser._id }, { leaders: assignedUser._id }],
          status: "active",
        }).select("_id").lean()
      : null;

    // ── Process rows ────────────────────────────────────────────────────────
    const results: Array<{
      index: number;
      status: "created" | "duplicate" | "invalid";
      leadId?: string;
      phone?: string;
      reason?: string;
    }> = [];

    // Terminal statuses — never override even when counselor is selected
    const TERMINAL_STATUSES = new Set(["closed", "lost", "not_connected", "wrong_number", "repeated", "cnc", "mia"]);

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i] as unknown[];

      // Skip completely empty rows
      const rowStr = row.map((c) => String(c ?? "").trim());
      if (rowStr.every((c) => !c)) continue;

      const rawName  = idxName  >= 0 ? String(row[idxName]  ?? "").trim() : "";
      const rawPhone = idxPhone >= 0 ? String(row[idxPhone] ?? "").trim() : "";

      if (!rawPhone) {
        results.push({ index: i, status: "invalid", reason: "Missing phone number" });
        continue;
      }

      const name = rawName || "No Name";

      const phone = rawPhone.replace(/^p:/i, "").replace(/\s+/g, "").replace(/^\+/, "");

      // Duplicate check
      const exists = await Lead.findOne({ phone });
      if (exists) {
        results.push({ index: i, status: "duplicate", leadId: exists._id.toString(), phone });
        continue;
      }

      // ── Map core fields ──────────────────────────────────────────────────
      const rawSource = idxSource >= 0 ? String(row[idxSource] ?? "").trim() : "";
      const source    = sourceOverride || mapLegacySource(rawSource);

      const rawDate   = idxDate >= 0 ? row[idxDate] : null;
      const createdAt = parseLegacyDate(rawDate) || new Date();

      const rawStatus  = idxStatus >= 0 ? String(row[idxStatus] ?? "").trim() : "";
      const sheetStatus = rawStatus ? mapLegacyStatus(rawStatus) : "new";

      // Status logic: preserve terminal statuses; set "assigned" only for new/followup when counselor selected
      let finalStatus = sheetStatus;
      if (assignedUser && sheetStatus === "new") {
        // Only override to "assigned" when the sheet had no meaningful status
        // All other statuses (followup, pending_response, callback…) are preserved as-is
        finalStatus = "assigned";
      }

      const rawResponse = idxResponse >= 0 ? String(row[idxResponse] ?? "").trim() : "";
      const initialLeadResponse = rawResponse ? mapInitialResponse(rawResponse) : null;

      const rawConcern = idxConcern >= 0 ? String(row[idxConcern] ?? "").trim() : "";
      const primaryConcern = rawConcern ? mapPrimaryConcern(rawConcern) : null;

      const rawFollowupType = idxFollowupType >= 0 ? String(row[idxFollowupType] ?? "").trim() : "";
      const followupStrategyType = rawFollowupType ? mapFollowupStrategy(rawFollowupType) : null;

      const campaign = idxCampaigns >= 0 ? String(row[idxCampaigns] ?? "").trim() : undefined;

      // ── Direct lead fields (no longer in notes) ──────────────────────────
      // Excel time-only cells come back as Date objects (1899-12-30 base date)
      // when cellDates:true — format them as "HH:MM AM/PM" instead of full JS date string
      const rawReceived = idxReceived >= 0 ? row[idxReceived] : "";
      let leadReceivedTime: string | undefined;
      if (rawReceived instanceof Date) {
        const h = rawReceived.getUTCHours();
        const m = rawReceived.getUTCMinutes();
        const ampm = h >= 12 ? "PM" : "AM";
        const hh = h % 12 === 0 ? 12 : h % 12;
        const mm = String(m).padStart(2, "0");
        leadReceivedTime = `${hh}:${mm} ${ampm}`;
      } else {
        const s = String(rawReceived ?? "").trim().slice(0, 50);
        leadReceivedTime = s || undefined;
      }
      const exactConcern     = idxExact >= 0 ? String(row[idxExact] ?? "").trim().slice(0, 1000) || undefined : undefined;
      const rawDemoSched     = idxDemoSched >= 0 ? String(row[idxDemoSched] ?? "").trim() : "";
      const demoScheduled    = rawDemoSched ? rawDemoSched.toLowerCase() === "yes" || rawDemoSched === "true" : undefined;
      const rawDemoAtten     = idxDemoAtten >= 0 ? String(row[idxDemoAtten] ?? "").trim() : "";
      const demoAttended     = rawDemoAtten ? rawDemoAtten.toLowerCase() === "yes" || rawDemoAtten === "true" : undefined;
      const rawLastFollowup  = idxLastFollowup >= 0 ? String(row[idxLastFollowup] ?? "").trim() : "";
      const lastFollowupDate = rawLastFollowup ? parseLegacyDate(rawLastFollowup) : undefined;
      const comments         = idxComments >= 0 ? String(row[idxComments] ?? "").trim().slice(0, 2000) || undefined : undefined;

      // ── Build notes array ─────────────────────────────────────────────────
      const priceOrCampaign = idxPriceCamp >= 0 ? String(row[idxPriceCamp] ?? "").trim() : "";
      const importNoteLines: string[] = [`📋 Lead Import — ${source}`, "─────────────────────────────"];
      if (priceOrCampaign) importNoteLines.push(`💰 ${priceOrCampaign}`);
      if (campaign) importNoteLines.push(`📢 Campaign: ${campaign}`);
      const importNote = { content: importNoteLines.join("\n"), author: reporterId, createdAt, updatedAt: createdAt };

      const notes: { content: string; author: typeof reporterId; createdAt: Date; updatedAt: Date }[] = [importNote];
      if (comments) {
        notes.push({ content: comments, author: reporterId, createdAt, updatedAt: createdAt });
      }

      try {
        const lead = await Lead.create({
          name,
          phone,
          source,
          status: finalStatus,
          assignedTo: assignedUser ? assignedUser._id : null,
          assignedAt: assignedUser && !TERMINAL_STATUSES.has(sheetStatus) ? new Date() : null,
          team: assignedTeam ? assignedTeam._id : null,
          reporter: reporterId,
          campaign: campaign || undefined,
          initialLeadResponse: initialLeadResponse as "very_interested" | "not_interested" | "let_me_think" | null,
          primaryConcern: primaryConcern as "risk" | "price" | "time" | "trust" | "exact_concern" | null,
          followupStrategyType: followupStrategyType as "risk_based" | "price_based" | "time_based" | "trust_based" | null,
          leadReceivedTime: leadReceivedTime || undefined,
          exactConcern: exactConcern || undefined,
          demoScheduled: demoScheduled ?? null,
          demoAttended: demoAttended ?? null,
          lastFollowupDate: lastFollowupDate || null,
          createdAt,
          notes,
          activityLogs: [
            {
              action: "lead_created",
              description: `Lead imported from legacy sheet (${source})`,
              performedBy: reporterId,
              createdAt,
            },
            ...(assignedUser && !TERMINAL_STATUSES.has(sheetStatus) ? [{
              action: "lead_assigned" as const,
              description: "Lead assigned to counselor on import",
              performedBy: reporterId,
              createdAt,
            }] : []),
          ],
        });

        results.push({ index: i, status: "created", leadId: lead._id.toString(), phone });
      } catch (rowErr: unknown) {
        const msg = rowErr instanceof Error ? rowErr.message : String(rowErr);
        results.push({ index: i, status: "invalid", phone, reason: msg });
      }
    }

    // The counsellors given open leads by the import hear about them, one notice each (2026-10-19). Old leads coming
    // back in — not announced as new ones.
    {
      const ids = results.filter((r) => r.status === "created" && r.leadId).map((r) => r.leadId as string);
      if (ids.length) {
        void Lead.find({ _id: { $in: ids }, assignedTo: { $ne: null }, status: { $nin: ["closed", "lost"] } })
          .select("name assignedTo").lean()
          .then((owned) => collectAssignments(async () => {
            for (const l of owned) if (String(l.assignedTo) !== String(reporterId)) await notifyLeadAssignment(String(l.assignedTo), String(l._id), l.name ?? "");
          }))
          .catch(() => null);
      }
    }

    const created   = results.filter((r) => r.status === "created").length;
    const duplicate = results.filter((r) => r.status === "duplicate").length;
    const invalid   = results.filter((r) => r.status === "invalid").length;

    sendSuccess(res, `Legacy import complete: ${created} created, ${duplicate} duplicate, ${invalid} invalid`, {
      summary: { total: results.length, created, duplicate, invalid },
      results,
    }, 201);
  } catch (err) {
    next(err);
  }
};

export const createLead = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = createLeadSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(
        res,
        "Validation failed",
        400,
        parsed.error.flatten().fieldErrors,
      );
      return;
    }

    const data = {
      ...parsed.data,
      email:        parsed.data.email  || undefined,
      team:         parsed.data.team   || undefined,
      assignedTo:   parsed.data.assignedTo || undefined,
      referralType: parsed.data.referralType ?? undefined,
      referredBy:   parsed.data.referredBy?.trim() || undefined,
    };

    // If team has autoAssign enabled, leave assignedTo null so autoSplitLead
    // can either assign immediately (no splitTime) or hold in Batch (splitTime set).
    // Otherwise fall back to assigning the lead to the creator.
    let teamAutoAssign = false;
    if (data.team && !data.assignedTo) {
      const teamDoc = await Team.findById(data.team).select("settings.autoAssign").lean();
      teamAutoAssign = !!(teamDoc?.settings?.autoAssign);
    }
    if (!data.assignedTo && !teamAutoAssign) {
      data.assignedTo = req.user!.userId;
    }

    // A number already in the CRM is that lead coming in again, never a second copy (2026-10-23): held for its team
    // leader to verify, as from the sheet; whoever typed it is told.
    const existing = await findLeadByPhone(data.phone);
    if (existing) {
      const out = await holdRepeatLead(String(existing._id), { name: data.name, source: data.source ?? null, note: "Added again by hand" }, req.user!.userId);
      if (out.kind === "held") void announceRepeats([out]);
      else await leadService.autoAssignLeads([out.leadId]).catch(() => null);
      sendError(res, repeatMessage(out), 409, { leadId: [out.leadId], outcome: [out.kind] });
      return;
    }

    const lead = await leadService.createLead(data, req.user!.userId);

    // Instant WhatsApp welcome (fire-and-forget — never blocks creation)
    {
      const newLeadId = (lead as unknown as { _id?: { toString(): string } })?._id?.toString();
      if (newLeadId) void sendWelcomeToLead(newLeadId);
    }

    // Trigger auto-split after creation when autoAssign is on.
    // autoSplitLead handles the splitTime gate internally:
    //   - splitTime set   → holds lead in Batch (assignedTo stays null)
    //   - no splitTime    → assigns to a member immediately
    if (teamAutoAssign && data.team) {
      const leadId = (lead as unknown as { _id: { toString(): string } })?._id?.toString();
      if (leadId) void autoSplitLeadPublic(data.team, leadId, req.user!.userId);
    }

    // Tell people (2026-10-19): the person it was given to, when that isn't whoever made it, and the team's leaders,
    // the Super Admins and the Sales Manager that a lead came in.
    {
      const newId = (lead as unknown as { _id?: { toString(): string } })?._id?.toString();
      if (newId) {
        if (data.assignedTo && String(data.assignedTo) !== req.user!.userId) {
          void notifyLeadAssignment(String(data.assignedTo), newId, data.name ?? "");
        }
        void announceNewLeads([newId], { by: req.user!.userId });
      }
    }

    sendSuccess(res, "Lead created successfully", lead, 201);
  } catch (error) {
    next(error);
  }
};

export const getLeadSources = async (
  _req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const sources = await Lead.distinct("source", { source: { $nin: [null, ""] } });
    const sorted = (sources as string[]).filter(Boolean).sort((a, b) => a.localeCompare(b));
    sendSuccess(res, "Lead sources fetched", sorted);
  } catch (error) {
    next(error);
  }
};

export const getLeads = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const role = req.user?.role as IRole | undefined;
    const { leads, pagination } = await leadService.getLeads(
      req.query as Record<string, string>,
      req.user?.userId,
      role,
    );
    sendSuccess(res, "Leads retrieved successfully", leads, 200, pagination);
  } catch (error) {
    next(error);
  }
};

export const getLeadById = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const lead = await leadService.getLeadById(req.params.id);
    sendSuccess(res, "Lead retrieved successfully", lead);
  } catch (error) {
    next(error);
  }
};

export const updateLead = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = updateLeadSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(
        res,
        "Validation failed",
        400,
        parsed.error.flatten().fieldErrors,
      );
      return;
    }

    const data: Record<string, unknown> = { ...parsed.data };
    if (data.email === "" || data.email === null) data.email = undefined;

    const lead = await leadService.updateLead(
      req.params.id,
      data as Parameters<typeof leadService.updateLead>[1],
      req.user!.userId,
    );
    sendSuccess(res, "Lead updated successfully", lead);
  } catch (error) {
    next(error);
  }
};

export const updateLeadStatus = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = updateStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(
        res,
        "Validation failed",
        400,
        parsed.error.flatten().fieldErrors,
      );
      return;
    }

    const lead = await leadService.updateLeadStatus(
      req.params.id,
      parsed.data.status,
      req.user!.userId,
      parsed.data.lostReason,
      parsed.data.lostNotes,
      parsed.data.status === "followup"
        ? {
            note: parsed.data.followUpNote!.trim(),
            followedUpAt: new Date(parsed.data.followUpAt!),
            nextFollowUpAt: parsed.data.nextFollowUpAt
              ? new Date(parsed.data.nextFollowUpAt)
              : null,
          }
        : undefined,
      parsed.data.status === "meeting_scheduled"
        ? { at: new Date(parsed.data.meetingAt!), note: parsed.data.meetingNote?.trim() || undefined }
        : undefined,
    );
    sendSuccess(res, "Lead status updated successfully", lead);
  } catch (error) {
    next(error);
  }
};

export const assignLead = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = assignLeadSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(
        res,
        "Validation failed",
        400,
        parsed.error.flatten().fieldErrors,
      );
      return;
    }

    const lead = await leadService.assignLead(
      req.params.id,
      parsed.data.userId,
      req.user!.userId,
    );

    // ── Notify the assigned user — kept in the bell, live and pushed (2026-10-19) ──
    const leadDoc = lead as unknown as { name?: string; _id?: { toString(): string } };
    void notifyLeadAssignment(parsed.data.userId, leadDoc?._id?.toString() ?? req.params.id, leadDoc?.name ?? "a new lead");

    sendSuccess(res, "Lead assigned successfully", lead);
  } catch (error) {
    next(error);
  }
};

export const deleteLead = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const result = await leadService.deleteLead(req.params.id);
    sendSuccess(res, result.message);
  } catch (error) {
    next(error);
  }
};

export const getLeadsByUser = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { leads, pagination } = await leadService.getLeadsByUser(
      req.params.userId,
      req.query as Record<string, string>,
    );
    sendSuccess(
      res,
      "User leads retrieved successfully",
      leads,
      200,
      pagination,
    );
  } catch (error) {
    next(error);
  }
};

export const getUserLeadStats = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const stats = await leadService.getUserLeadStats(req.params.userId);
    sendSuccess(res, "User lead stats retrieved successfully", stats);
  } catch (error) {
    next(error);
  }
};

export const getUserRevenue = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { userId } = req.params;
    const { period, from, to } = req.query as Record<string, string>;

    // Build date range
    const now = new Date();
    let dateFrom: Date;
    let dateTo: Date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    if (period === "today") {
      dateFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    } else if (period === "week") {
      const day = now.getDay();
      const diff = (day === 0 ? -6 : 1 - day); // Monday start
      dateFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff, 0, 0, 0, 0);
    } else if (period === "month") {
      dateFrom = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      dateTo   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    } else if (period === "year") {
      dateFrom = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
      dateTo   = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
    } else if (period === "custom" && from && to) {
      dateFrom = new Date(from);
      dateTo   = new Date(to);
      dateTo.setHours(23, 59, 59, 999);
    } else {
      // Default: all time
      dateFrom = new Date(0);
      dateTo   = new Date(8640000000000000);
    }

    const result = await Lead.aggregate([
      {
        $match: {
          assignedTo: new mongoose.Types.ObjectId(userId),
          "payments.paidAt": { $gte: dateFrom, $lte: dateTo },
        },
      },
      { $unwind: "$payments" },
      { $match: COUNTED_PAYMENT },
      { $match: { "payments.paidAt": { $gte: dateFrom, $lte: dateTo } } },
      {
        $group: {
          _id: null,
          totalRevenue:   { $sum: "$payments.amount" },
          paymentCount:   { $sum: 1 },
          leadCount:      { $addToSet: "$_id" },
        },
      },
      {
        $project: {
          _id: 0,
          totalRevenue: 1,
          paymentCount: 1,
          leadCount: { $size: "$leadCount" },
        },
      },
    ]);

    const data = result[0] ?? { totalRevenue: 0, paymentCount: 0, leadCount: 0 };
    sendSuccess(res, "Revenue fetched", { ...data, period: period ?? "all", dateFrom, dateTo });
  } catch (error) {
    next(error);
  }
};

export const autoAssignLeads = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = autoAssignSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(
        res,
        "Validation failed",
        400,
        parsed.error.flatten().fieldErrors,
      );
      return;
    }

    const result = await leadService.autoAssignLeads(parsed.data.leadIds, parsed.data.teamIds);
    sendSuccess(
      res,
      `Successfully assigned ${result.assigned} lead(s)`,
      result,
    );
  } catch (error) {
    next(error);
  }
};

// ─── Note Controllers ─────────────────────────────────────────────────────────

export const addNote = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = noteSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(
        res,
        "Validation failed",
        400,
        parsed.error.flatten().fieldErrors,
      );
      return;
    }

    const lead = await leadService.addNote(
      req.params.id,
      parsed.data.content,
      req.user!.userId,
    );
    sendSuccess(res, "Note added successfully", lead, 201);
  } catch (error) {
    next(error);
  }
};

export const updateNote = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = noteSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(
        res,
        "Validation failed",
        400,
        parsed.error.flatten().fieldErrors,
      );
      return;
    }

    const lead = await leadService.updateNote(
      req.params.id,
      req.params.noteId,
      parsed.data.content,
      req.user!.userId,
    );
    sendSuccess(res, "Note updated successfully", lead);
  } catch (error) {
    next(error);
  }
};

export const deleteNote = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const role = req.user?.role as IRole | undefined;
    const isSuperAdmin =
      role?.isSystemRole === true && role?.roleName === "Super Admin";

    const lead = await leadService.deleteNote(
      req.params.id,
      req.params.noteId,
      req.user!.userId,
      isSuperAdmin,
    );
    sendSuccess(res, "Note deleted successfully", lead);
  } catch (error) {
    next(error);
  }
};

// ─── Team assignment ───────────────────────────────────────────────────────────

const assignTeamSchema = z.object({ teamId: z.string().min(1, "Team ID is required") });

export const assignLeadToTeam = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = assignTeamSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }
    const lead = await leadService.assignLeadToTeam(
      req.params.id,
      parsed.data.teamId,
      req.user!.userId,
    );
    sendSuccess(res, "Lead assigned to team successfully", lead);
  } catch (error) {
    next(error);
  }
};

// ─── Bulk Operations ──────────────────────────────────────────────────────────

const bulkLeadIdsSchema = z.object({
  leadIds: z.array(z.string().min(1)).min(1, "At least one lead ID is required"),
});

export const bulkUpdateLeadStatus = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = bulkLeadIdsSchema
      .extend({
        // Not meeting_scheduled: each lead needs its own meeting time
        status:     z.enum(["new", "assigned", "pending_response", "followup", "meeting_done", "closed", "lost", "not_connected", "wrong_number", "mia", "repeated", "callback", "cnc"]),
        lostReason: z.enum(LOST_REASONS).optional(),
        lostNotes:  z.string().max(500).optional(),
        followUpNote:   z.string().max(2000).optional(),
        followUpAt:     z.string().optional(),
        nextFollowUpAt: z.string().optional().nullable(),
      })
      .superRefine((data, ctx) => {
        if (data.status === "lost" && !data.lostReason) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lostReason"], message: "Lost reason is required when status is lost" });
        }
        if (data.status === "lost" && !data.lostNotes?.trim()) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lostNotes"], message: "Notes are required when marking a lead as lost" });
        }
        if (data.status === "followup") {
          if (!data.followUpNote?.trim()) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["followUpNote"], message: "Follow-up details are required when status is followup" });
          }
          if (!data.followUpAt || isNaN(new Date(data.followUpAt).getTime())) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["followUpAt"], message: "Follow-up date & time is required when status is followup" });
          }
        }
      })
      .safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }
    const result = await leadService.bulkUpdateStatus(
      parsed.data.leadIds,
      parsed.data.status,
      req.user!.userId,
      parsed.data.lostReason,
      parsed.data.lostNotes,
      parsed.data.status === "followup"
        ? {
            note: parsed.data.followUpNote!.trim(),
            followedUpAt: new Date(parsed.data.followUpAt!),
            nextFollowUpAt: parsed.data.nextFollowUpAt
              ? new Date(parsed.data.nextFollowUpAt)
              : null,
          }
        : undefined,
    );
    sendSuccess(res, `${result.updated} lead(s) status updated`, result);
  } catch (error) {
    next(error);
  }
};

export const bulkDeleteLeads = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = bulkLeadIdsSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }
    const result = await leadService.bulkDelete(parsed.data.leadIds);
    sendSuccess(res, `${result.deleted} lead(s) deleted`, result);
  } catch (error) {
    next(error);
  }
};

export const bulkAssignLeadsToTeam = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = bulkLeadIdsSchema
      .extend({ teamId: z.string().min(1, "Team ID is required") })
      .safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }
    const result = await leadService.bulkAssignToTeam(
      parsed.data.leadIds,
      parsed.data.teamId,
      req.user!.userId,
    );
    sendSuccess(res, `${result.updated} lead(s) assigned to team`, result);
  } catch (error) {
    next(error);
  }
};

export const transferLeadToTeam = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = assignTeamSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }
    const lead = await leadService.transferLeadToTeam(
      req.params.id,
      parsed.data.teamId,
      req.user!.userId,
    );
    sendSuccess(res, "Lead transferred to team successfully", lead);
  } catch (error) {
    next(error);
  }
};

// ─── Reminder Controllers ─────────────────────────────────────────────────────

const AED_OFFSET_MS = 4 * 60 * 60 * 1000; // UTC+4 (AED/GST)

const reminderSchema = z.object({
  title:    z.string().max(200).optional(),
  note:     z.string().max(1000).optional(),
  remindAt: z
    .string()
    .min(1, "remindAt is required")
    .refine((val) => {
      const d = new Date(val);
      return !isNaN(d.getTime());
    }, "Invalid date/time format")
    .refine((val) => {
      const d = new Date(val);
      // Allow a 60-second grace window so a reminder set "right now" isn't
      // rejected due to slight clock drift between client and server.
      const nowAED = new Date(Date.now() - AED_OFFSET_MS);
      return d.getTime() > nowAED.getTime() - 60_000;
    }, "Reminder time must be in the future (GST)"),
  isDone:   z.boolean().optional(),
});

/** GET /leads/reminders/mine — all active reminders for the current user */
/**
 * GET /leads/followups/mine/today
 * Leads assigned to the current user whose nextFollowUpAt is due today (GST)
 * or overdue — powers the daily dashboard pop-up.
 */
export const getMyTodayFollowups = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = req.user!.userId;
    // End of today in GST (UTC+4)
    const gstOffsetMs = 4 * 3600 * 1000;
    const nowGst = new Date(Date.now() + gstOffsetMs);
    const endOfTodayUtc = new Date(
      Date.UTC(nowGst.getUTCFullYear(), nowGst.getUTCMonth(), nowGst.getUTCDate() + 1) - gstOffsetMs,
    );

    // Two groups: leads with a scheduled next follow-up due today/overdue, plus
    // followup-status leads that have NO scheduled time (legacy / optional field)
    // so the daily pop-up still lists them.
    const leads = await Lead.find(
      {
        assignedTo: new mongoose.Types.ObjectId(userId),
        status: { $nin: ["closed", "lost"] },
        $or: [
          { nextFollowUpAt: { $ne: null, $lte: endOfTodayUtc } },
          { status: "followup", nextFollowUpAt: null },
        ],
      },
      { name: 1, phone: 1, status: 1, source: 1, nextFollowUpAt: 1, missedFollowUpWarnedAt: 1, lastFollowupDate: 1 },
    )
      .limit(200)
      .lean();

    // Scheduled ones first (earliest due first), then unscheduled by most recent follow-up
    leads.sort((a, b) => {
      if (a.nextFollowUpAt && b.nextFollowUpAt) return new Date(a.nextFollowUpAt).getTime() - new Date(b.nextFollowUpAt).getTime();
      if (a.nextFollowUpAt) return -1;
      if (b.nextFollowUpAt) return 1;
      return new Date(b.lastFollowupDate ?? 0).getTime() - new Date(a.lastFollowupDate ?? 0).getTime();
    });

    sendSuccess(res, "Today's follow-ups fetched", leads.slice(0, 150));
  } catch (error) {
    next(error);
  }
};

export const getMyReminders = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const leads = await Lead.find(
      { "reminders.createdBy": new mongoose.Types.ObjectId(userId) },
      { name: 1, phone: 1, email: 1, status: 1, assignedTo: 1, team: 1, reminders: 1 },
    )
      .populate("assignedTo", "name email")
      .populate("team", "name")
      .lean();

    // flatten: one entry per reminder that belongs to this user
    const items = leads.flatMap((lead) =>
      (lead.reminders ?? [])
        .filter((r) => r.createdBy?.toString() === userId)
        .map((r) => ({
          ...r,
          lead: {
            _id: lead._id,
            name: lead.name,
            phone: lead.phone,
            email: lead.email,
            status: lead.status,
            assignedTo: lead.assignedTo,
            team: lead.team,
          },
        })),
    );

    // Sort by remindAt ascending
    type ReminderItem = (typeof items)[number] & { remindAt: Date };
    (items as ReminderItem[]).sort((a, b) => new Date(a.remindAt).getTime() - new Date(b.remindAt).getTime());

    sendSuccess(res, "Reminders fetched", items);
  } catch (error) {
    next(error);
  }
};

/** GET /leads/reminders/count — count of undone future reminders */
export const getMyReminderCount = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const leads = await Lead.find(
      { "reminders.createdBy": new mongoose.Types.ObjectId(userId) },
      { reminders: 1 },
    ).lean();

    let count = 0;
    for (const lead of leads) {
      count += (lead.reminders ?? []).filter(
        (r) => r.createdBy?.toString() === userId && !r.isDone,
      ).length;
    }
    sendSuccess(res, "Count fetched", { count });
  } catch (error) {
    next(error);
  }
};

/** POST /leads/:id/reminders */
export const addReminder = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = reminderSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }
    const lead = await Lead.findById(req.params.id);
    if (!lead) { sendError(res, "Lead not found", 404); return; }

    lead.reminders.push({
      title:     parsed.data.title,
      note:      parsed.data.note,
      remindAt:  new Date(parsed.data.remindAt),
      createdBy: new mongoose.Types.ObjectId(req.user!.userId),
      isDone:    false,
    } as never);

    await lead.save();
    const added = lead.reminders[lead.reminders.length - 1];
    sendSuccess(res, "Reminder added", added, 201);
  } catch (error) {
    next(error);
  }
};

/** PUT /leads/:id/reminders/:reminderId */
export const updateReminder = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = reminderSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }
    const lead = await Lead.findById(req.params.id);
    if (!lead) { sendError(res, "Lead not found", 404); return; }

    const reminder = lead.reminders.id(req.params.reminderId);
    if (!reminder) { sendError(res, "Reminder not found", 404); return; }

    if (parsed.data.title    !== undefined) reminder.title    = parsed.data.title;
    if (parsed.data.note     !== undefined) reminder.note     = parsed.data.note;
    if (parsed.data.remindAt !== undefined) {
      const from = reminder.remindAt, to = new Date(parsed.data.remindAt);
      if (!from || from.getTime() !== to.getTime()) {
        // A new time is a new alert: the scheduler sends one only while these are empty (2026-10-22).
        syncFollowUpDateWithReminder(lead, reminder, from, to);
        reminder.remindAt = to;
        Object.assign(reminder, { notifiedAt: null, warnedAt: null });
      }
    }
    if (parsed.data.isDone   !== undefined) reminder.isDone   = parsed.data.isDone;

    await lead.save();
    sendSuccess(res, "Reminder updated", reminder);
  } catch (error) {
    next(error);
  }
};

/** DELETE /leads/:id/reminders/:reminderId */
export const deleteReminder = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) { sendError(res, "Lead not found", 404); return; }

    const reminder = lead.reminders.id(req.params.reminderId);
    if (!reminder) { sendError(res, "Reminder not found", 404); return; }

    reminder.deleteOne();
    await lead.save();
    sendSuccess(res, "Reminder deleted");
  } catch (error) {
    next(error);
  }
};

// ─── Payment Controllers ──────────────────────────────────────────────────────

const paymentBodySchema = z.object({
  amount: z.number().min(0, "Amount cannot be negative"),
  note:   z.string().max(500).optional(),
  paidAt: z.string().min(1, "paidAt is required"),
  // How it was paid and its receipt, as at the close (2026-10-23).
  method: z.enum(ENROLMENT_PAYMENT_METHODS).optional(),
  receipt: z.object({
    name: z.string().max(200).optional(),
    url: z.string().regex(/^https?:\/\//, "The receipt has no link"),
    key: z.string().min(1).max(500),
    size: z.number().optional(),
    mimeType: z.string().max(100).optional(),
  }).optional(),
});

/** A payment the close itself puts on the lead — "Collected at enrolment — …": its method and receipt are on the close. */
const fromTheClose = (note?: string | null) => /^Collected at enrolment\b/.test(note ?? "");

/** The receipt as kept on the lead — only one uploaded for this lead (enrolment-receipts/<lead>/…). */
function leadReceipt(leadId: string, r: z.infer<typeof paymentBodySchema>["receipt"]) {
  if (!r) return undefined;
  if (!r.key.startsWith(`enrolment-receipts/${leadId}/`)) return null;
  return { name: r.name || "Receipt", url: r.url, key: r.key, ...(r.size ? { size: r.size } : {}), ...(r.mimeType ? { mimeType: r.mimeType } : {}), uploadedAt: new Date() };
}

/** POST /leads/:id/payments */
export const addPayment = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = paymentBodySchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }
    const lead = await Lead.findById(req.params.id);
    if (!lead) { sendError(res, "Lead not found", 404); return; }
    // Once the close is in finance a payment here must reach finance, or the invoice, the LMS and CS Portal
    // never hear of it (2026-10-23) — it goes through POST /leads/:id/payments/finance, with its receipt.
    if (await closeIsInFinance(String(lead._id))) {
      sendError(res, "This lead's enrolment is in finance — send the payment to finance with its receipt, so the invoice, the LMS and CS Portal get it.", 409);
      return;
    }

    // How it was paid and its receipt are asked, as at the close (2026-10-23) — but not of the close's own payments,
    // whose method and receipt the close itself carries.
    const receipt = leadReceipt(String(lead._id), parsed.data.receipt);
    if (receipt === null) { sendError(res, "That receipt wasn't uploaded for this lead — attach it again.", 400); return; }
    if (!fromTheClose(parsed.data.note) && (!parsed.data.method || !receipt)) {
      sendError(res, "Say how it was paid and attach the receipt, as at the close.", 400);
      return;
    }

    lead.payments.push({
      amount:  parsed.data.amount,
      note:    parsed.data.note,
      paidAt:  new Date(parsed.data.paidAt),
      addedBy: new mongoose.Types.ObjectId(req.user!.userId),
      ...(parsed.data.method ? { method: parsed.data.method } : {}),
      ...(receipt ? { receipt } : {}),
    } as never);

    await lead.save();
    const added = lead.payments[lead.payments.length - 1];
    sendSuccess(res, "Payment recorded", added, 201);
  } catch (error) {
    next(error);
  }
};

/** PUT /leads/:id/payments/:paymentId */
export const updatePayment = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = paymentBodySchema.partial().safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }
    const lead = await Lead.findById(req.params.id);
    if (!lead) { sendError(res, "Lead not found", 404); return; }

    const payment = lead.payments.id(req.params.paymentId);
    if (!payment) { sendError(res, "Payment not found", 404); return; }
    // Sent to finance: it is finance's now — a change here would not reach the invoice.
    if (payment.finance?.externalId && (parsed.data.amount !== undefined || parsed.data.paidAt !== undefined || parsed.data.method !== undefined || parsed.data.receipt !== undefined)) {
      sendError(res, "This payment was sent to finance — ask accounts to change it there.", 409);
      return;
    }

    if (parsed.data.receipt !== undefined) {
      const receipt = leadReceipt(String(lead._id), parsed.data.receipt);
      if (!receipt) { sendError(res, "That receipt wasn't uploaded for this lead — attach it again.", 400); return; }
      payment.receipt = receipt;
    }
    if (parsed.data.method !== undefined) payment.method = parsed.data.method;
    if (parsed.data.amount !== undefined) payment.amount = parsed.data.amount;
    if (parsed.data.note   !== undefined) payment.note   = parsed.data.note;
    if (parsed.data.paidAt !== undefined) payment.paidAt = new Date(parsed.data.paidAt);

    await lead.save();
    sendSuccess(res, "Payment updated", payment);
  } catch (error) {
    next(error);
  }
};

// ─── Call counts ──────────────────────────────────────────────────────────────
//
// Since 2026-10-14 a lead's call counts come from 3CX (callSyncService.recountLeadCalls) and are not changed by
// hand: these two routes stay for a web app still open from before, and only answer with the counts as they are.

async function currentCallCounts(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const lead = await Lead.findById(req.params.id).select("callCount callConnected callNotConnected").lean();
    if (!lead) { sendError(res, "Lead not found", 404); return; }
    sendSuccess(res, "Call counts come from 3CX and are not changed by hand", {
      callCount: lead.callCount ?? 0,
      callConnected: (lead as { callConnected?: number }).callConnected ?? 0,
      callNotConnected: lead.callNotConnected ?? 0,
      fromThreecx: true,
    });
  } catch (error) {
    next(error);
  }
}

/** PATCH /leads/:id/call-not-connected — no longer changes anything (counts from 3CX). */
export const updateCallNotConnected = currentCallCounts;

/** PATCH /leads/:id/call-count — no longer changes anything (counts from 3CX). */
export const updateCallCount = currentCallCounts;

/** GET /leads/:id/payments/finance — the close in finance, and which of the lead's payments finance has (2026-10-23). */
export const getLeadPaymentFinance = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const link = await leadFinanceLink({ userId: req.user!.userId, role: req.user!.role ?? null }, String(req.params.id));
    if (!link) { sendError(res, "Lead not found", 404); return; }
    sendSuccess(res, "Payments in finance", link);
  } catch (error) {
    next(error);
  }
};

/** POST /leads/:id/payments/finance — a payment on a closed lead, sent to finance with its receipt (2026-10-23). */
export const sendLeadPaymentToFinance = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const sent = await sendLeadPayment({ userId: req.user!.userId, role: req.user!.role ?? null }, String(req.params.id), (req.body ?? {}) as Record<string, unknown>);
    sendSuccess(res, "Sent to finance for approval", sent, 201);
  } catch (error) {
    const e = error as { statusCode?: number; message?: string };
    if (e?.statusCode) { sendError(res, e.message ?? "Could not send it", e.statusCode); return; }
    next(error);
  }
};

/** DELETE /leads/:id/payments/:paymentId */
export const deletePayment = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) { sendError(res, "Lead not found", 404); return; }

    const payment = lead.payments.id(req.params.paymentId);
    if (!payment) { sendError(res, "Payment not found", 404); return; }
    if (payment.finance?.externalId) {
      sendError(res, "This payment was sent to finance — ask accounts to remove it there.", 409);
      return;
    }

    payment.deleteOne();
    await lead.save();
    sendSuccess(res, "Payment deleted");
  } catch (error) {
    next(error);
  }
};

// ── Follow-Ups ────────────────────────────────────────────────────────────────

export const addFollowUp = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = z.object({
      note:           z.string().max(1000).optional(),
      followedUpAt:   z.string().datetime().optional(),
      nextFollowUpAt: z.string().datetime().nullable().optional(),
    }).safeParse(req.body);

    if (!parsed.success) {
      sendError(res, parsed.error.issues[0].message, 400);
      return;
    }

    const userId = req.user!.userId;
    const { note, followedUpAt, nextFollowUpAt } = parsed.data;

    const entry = await leadService.addFollowUp(req.params.id, userId, {
      note,
      followedUpAt:   followedUpAt ? new Date(followedUpAt) : undefined,
      nextFollowUpAt: nextFollowUpAt !== undefined ? (nextFollowUpAt ? new Date(nextFollowUpAt) : null) : undefined,
    });

    sendSuccess(res, "Follow-up logged", entry, 201);
  } catch (err) {
    next(err);
  }
};

/** PATCH /leads/:id/followup-date — change the next follow-up date (moves its "Follow-up due" reminder too). */
export const changeLeadFollowUpDate = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = z.object({
      nextFollowUpAt: z.string().datetime({ offset: true }),
      note:           z.string().max(1000).optional(),
    }).safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Pick a valid date and time", 400, parsed.error.flatten().fieldErrors);
      return;
    }
    const result = await changeFollowUpDate(req.params.id, req.user!.userId, new Date(parsed.data.nextFollowUpAt), parsed.data.note);
    sendSuccess(res, "Follow-up date changed", result);
  } catch (err) {
    next(err);
  }
};

export const getFollowUps = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const data = await leadService.getFollowUps(req.params.id);
    sendSuccess(res, "Follow-ups fetched", data);
  } catch (err) {
    next(err);
  }
};
