import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { Lead } from "../models/Lead.js";
import { User } from "../models/User.js";
import { LeadService } from "../services/leadService.js";
import { notifyLeadAssignment, notifyBulkLeadAssignment } from "../services/pushService.js";
import { emitToUser } from "../socket.js";
import { sendWelcomeToLead } from "../services/whatsappCloudService.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { announceNewLeads } from "../services/leadAlertService.js";

const leadService = new LeadService();

// ─── Validation Schema ────────────────────────────────────────────────────────
// Mirrors exactly the 17 columns in the Google Sheet export from Facebook Lead Ads

const sheetRowSchema = z.object({
  id: z.string().optional(), // Facebook lead ID  (e.g. l:1587516...)
  created_time: z.string().optional(), // ISO timestamp from Facebook
  ad_id: z.string().optional(),
  ad_name: z.string().optional(),
  adset_id: z.string().optional(),
  adset_name: z.string().optional(),
  campaign_id: z.string().optional(),
  campaign_name: z.string().optional(),
  form_id: z.string().optional(),
  form_name: z.string().optional(),
  is_organic: z.union([z.string(), z.boolean()]).optional(),
  platform: z.string().optional(), // "ig", "fb", "meta", etc.
  full_name: z.string().min(1, "full_name is required"),
  phone_number: z.string().min(1, "phone_number is required"),
  email: z.string().optional(),
  city: z.string().optional(),
  lead_status: z.string().optional(), // Facebook's own status (CREATED etc.)
  assigned_to: z.string().optional(), // CRM user ID — direct counselor assignment
  source: z.string().optional(), // override derived source (e.g. "meta - shuhaib leads")
  ad_creative: z.string().optional(), // ad creative name — stored in note
  reporter: z.string().optional(), //
});

type SheetRow = z.infer<typeof sheetRowSchema>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Strip the "p:" prefix Facebook sometimes adds to phone numbers */
function cleanPhone(raw: string): string {
  return raw.replace(/^p:/i, "").trim();
}

/** Return email only if it looks valid, otherwise undefined (prevents Mongoose rejection) */
function sanitizeEmail(raw?: string): string | undefined {
  const e = raw?.trim().toLowerCase();
  if (!e) return undefined;
  return /^\S+@\S+\.\S+$/.test(e) ? e : undefined;
}

/** Map platform shortcodes to CRM source values */
function mapPlatformToSource(platform?: string): string {
  if (!platform) return "other";
  const p = platform.toLowerCase();
  if (
    p === "meta" ||
    p === "ig" ||
    p === "instagram" ||
    p === "fb" ||
    p === "facebook"
  )
    return "meta";
  if (p === "wa" || p === "whatsapp") return "whatsapp";
  if (p === "google" || p === "gads" || p === "google ads") return "google";
  return "other";
}

/** Build note — includes all available metadata so nothing is lost */
function buildNote(row: SheetRow): string {
  const p = (row.platform ?? "").toLowerCase();
  const isWhatsApp = p === "wa" || p === "whatsapp";
  const isGoogle = p === "google" || p === "gads" || p === "google ads";

  const source =
    row.source ?? (isWhatsApp ? "WhatsApp" : isGoogle ? "Google Ads" : "Meta");

  const lines: string[] = [
    `📊 Lead Import — ${source}`,
    "─────────────────────────────",
  ];

  // Core contact info overflow
  if (row.email) lines.push(`📧 Email: ${row.email}`);
  if (row.city) lines.push(`📍 City: ${row.city}`);
  if (row.platform) lines.push(`📱 Platform: ${row.platform.toUpperCase()}`);

  // Ad creative (key field for this sheet)
  if (row.ad_creative) {
    lines.push("");
    lines.push("🎨 Ad Creative");
    lines.push("─────────────────────────────");
    lines.push(row.ad_creative);
  }

  // Campaign details
  const hasCampaignInfo =
    row.campaign_name ||
    row.campaign_id ||
    row.adset_name ||
    row.ad_name ||
    row.form_name;
  if (hasCampaignInfo) {
    lines.push("");
    lines.push("📢 Campaign Details");
    lines.push("─────────────────────────────");
    if (row.campaign_name)
      lines.push(
        `Campaign  : ${row.campaign_name}${row.campaign_id ? ` (ID: ${row.campaign_id})` : ""}`,
      );
    if (row.adset_name)
      lines.push(
        `Ad Set    : ${row.adset_name}${row.adset_id ? ` (${row.adset_id})` : ""}`,
      );
    if (row.ad_name)
      lines.push(
        `Ad        : ${row.ad_name}${row.ad_id ? ` (${row.ad_id})` : ""}`,
      );
    if (row.form_name)
      lines.push(
        `Form      : ${row.form_name}${row.form_id ? ` (${row.form_id})` : ""}`,
      );
  }

  // Extra metadata
  const hasExtra =
    row.is_organic !== undefined ||
    row.lead_status ||
    row.created_time ||
    row.id;
  if (hasExtra) {
    lines.push("");
    lines.push("ℹ️  Metadata");
    lines.push("─────────────────────────────");
    if (row.is_organic !== undefined)
      lines.push(`Organic   : ${String(row.is_organic)}`);
    if (row.lead_status) lines.push(`FB Status : ${row.lead_status}`);
    if (row.created_time) lines.push(`FB Created: ${row.created_time}`);
    if (row.id) lines.push(`FB Lead ID: ${row.id}`);
  }

  return lines.join("\n");
}

// ─── Controller ───────────────────────────────────────────────────────────────

/**
 * POST /api/sheets/sync
 *
 * Accepts a single row from the Google Sheet (one object per call).
 * - Maps core fields → Lead document
 * - Stores extra metadata as a Note on the lead
 * - Skips silently if a lead with the same phone already exists (returns existing lead ID)
 * - The Super Admin user is used as the system reporter
 */
export const syncSheetLead = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = sheetRowSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(
        res,
        "Validation failed",
        400,
        parsed.error.flatten().fieldErrors,
      );
      return;
    }

    const row = parsed.data;
    const phone = cleanPhone(row.phone_number);
    const email = sanitizeEmail(row.email);

    // ── Duplicate check on phone ───────────────────────────────────────────
    const existing = await Lead.findOne({ phone });
    if (existing) {
      sendSuccess(res, "Lead already exists — skipped", {
        leadId: existing._id.toString(),
        duplicate: true,
        phone,
      });
      return;
    }

    // ── Find Super Admin as system reporter ────────────────────────────────
    const superAdmin = await User.findOne({
      email: process.env.SUPER_ADMIN_EMAIL,
    });
    if (!superAdmin) {
      sendError(
        res,
        "System reporter (Super Admin) not found. Check SUPER_ADMIN_EMAIL in .env.",
        500,
      );
      return;
    }
    const reporterId = row?.reporter ? row.reporter : superAdmin._id.toString();

    // ── Build note from extra fields ───────────────────────────────────────
    const noteContent = buildNote(row);

    // ── Resolve direct counselor assignment ───────────────────────────────
    const assignedToId = row.assigned_to?.trim() || null;
    const assignedUser = assignedToId
      ? await User.findById(assignedToId).select("_id").lean()
      : null;

    // ── Create lead ────────────────────────────────────────────────────────
    const source = row.source?.trim() || mapPlatformToSource(row.platform);
    const lead = await Lead.create({
      name: row.full_name?.trim() || "no name",
      phone,
      email,
      source,
      platform: row.platform?.trim() || undefined,
      campaign: row.campaign_name?.trim() || undefined,
      status: assignedUser ? "assigned" : "new",
      assignedTo: assignedUser ? assignedUser._id : null,
      assignedAt: assignedUser ? new Date() : null,
      reporter: reporterId,
      notes: [
        {
          content: noteContent,
          author: reporterId,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      activityLogs: [
        {
          action: "lead_created",
          description: `Lead imported from Google Sheets (${source === "whatsapp" ? "WhatsApp" : source === "google" ? "Google Ads" : "Meta"})`,
          performedBy: reporterId,
          createdAt: new Date(),
        },
        ...(assignedUser
          ? [
              {
                action: "lead_assigned" as const,
                description: `Lead assigned to counselor on import`,
                performedBy: reporterId,
                createdAt: new Date(),
              },
            ]
          : []),
      ],
    });

    // Instant WhatsApp welcome (fire-and-forget — never blocks the sync)
    void sendWelcomeToLead(lead._id.toString());

    // Directly-assigned counselors (a person named by Root's split, an agent column) never went
    // through the split, which is the only place that notified them (the user, 2026-10-05)
    if (assignedUser) {
      void notifyLeadAssignment(String(assignedUser._id), lead._id.toString(), lead.name, emitToUser).catch(() => null);
    }

    // ── Auto-assign to team only if no direct counselor assigned ──────────
    let assignedTeam: string | null = null;
    if (!assignedUser) {
      try {
        const assignment = await leadService.autoAssignLeads([
          lead._id.toString(),
        ]);
        if (assignment.assigned > 0 && assignment.results[0]) {
          assignedTeam = assignment.results[0].assignedTo;
        }
      } catch {
        // No active teams — lead stays unassigned
      }
    }

    void announceNewLeads([lead._id]);

    sendSuccess(
      res,
      "Lead created successfully",
      {
        leadId: lead._id.toString(),
        duplicate: false,
        name: lead.name,
        phone: lead.phone,
        assignedTo: assignedUser ? assignedToId : null,
        assignedTeam:
          assignedTeam ?? (assignedUser ? "direct-assigned" : "unassigned"),
      },
      201,
    );
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/sheets/sync/batch
 *
 * Accepts an array of rows (bulk import from App Script).
 * Processes each row independently — duplicates are skipped, not errored.
 */
export const syncSheetLeadsBatch = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const rows = req.body?.rows;
    if (!Array.isArray(rows) || rows.length === 0) {
      sendError(res, '"rows" must be a non-empty array', 400);
      return;
    }

    if (rows.length > 200) {
      sendError(res, "Batch limit is 200 rows per request", 400);
      return;
    }

    const superAdmin = await User.findOne({
      email: process.env.SUPER_ADMIN_EMAIL,
    });
    if (!superAdmin) {
      sendError(res, "System reporter (Super Admin) not found", 500);
      return;
    }
    const reporterId = superAdmin._id.toString();

    const results: Array<{
      index: number;
      status: "created" | "duplicate" | "invalid";
      leadId?: string;
      phone?: string;
      reason?: string;
    }> = [];
    // counselor id → leads directly assigned to them in this batch
    const directByUser = new Map<string, { count: number; first: { id: string; name: string } }>();

    for (let i = 0; i < rows.length; i++) {
      const parsed = sheetRowSchema.safeParse(rows[i]);

      if (!parsed.success) {
        results.push({
          index: i,
          status: "invalid",
          reason: JSON.stringify(parsed.error.flatten().fieldErrors),
        });
        continue;
      }

      const row = parsed.data;
      const phone = cleanPhone(row.phone_number);
      const email = sanitizeEmail(row.email);

      // Check duplicate
      const exists = await Lead.findOne({ phone });
      if (exists) {
        results.push({
          index: i,
          status: "duplicate",
          leadId: exists._id.toString(),
          phone,
        });
        continue;
      }

      const noteContent = buildNote(row);
      const source = row.source?.trim() || mapPlatformToSource(row.platform);

      const assignedToId = row.assigned_to?.trim() || null;
      const assignedUser = assignedToId
        ? await User.findById(assignedToId).select("_id").lean()
        : null;

      try {
        const lead = await Lead.create({
          name: row.full_name.trim(),
          phone,
          email,
          source,
          platform: row.platform?.trim() || undefined,
          campaign: row.campaign_name?.trim() || undefined,
          status: assignedUser ? "assigned" : "new",
          assignedTo: assignedUser ? assignedUser._id : null,
          assignedAt: assignedUser ? new Date() : null,
          reporter: row?.reporter ? row.reporter : reporterId,
          notes: [
            {
              content: noteContent,
              author: reporterId,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          activityLogs: [
            {
              action: "lead_created",
              description: `Lead imported from Google Sheets (${source === "whatsapp" ? "WhatsApp" : source === "google" ? "Google Ads" : "Meta"})`,
              performedBy: reporterId,
              createdAt: new Date(),
            },
            ...(assignedUser
              ? [
                  {
                    action: "lead_assigned" as const,
                    description: `Lead assigned to counselor on import`,
                    performedBy: reporterId,
                    createdAt: new Date(),
                  },
                ]
              : []),
          ],
        });
        results.push({
          index: i,
          status: "created",
          leadId: lead._id.toString(),
          phone,
        });
        if (assignedUser) {
          const uid = String(assignedUser._id);
          const cur = directByUser.get(uid);
          directByUser.set(uid, cur ? { count: cur.count + 1, first: cur.first } : { count: 1, first: { id: lead._id.toString(), name: lead.name } });
        }

        // Instant WhatsApp welcome (fire-and-forget — never blocks the batch)
        void sendWelcomeToLead(lead._id.toString());
      } catch (rowErr: unknown) {
        const msg = rowErr instanceof Error ? rowErr.message : String(rowErr);
        results.push({ index: i, status: "invalid", phone, reason: msg });
      }
    }

    // One alert per counselor for this batch: the lead itself if one, a count if several
    for (const [uid, info] of directByUser) {
      if (info.count === 1) void notifyLeadAssignment(uid, info.first.id, info.first.name, emitToUser).catch(() => null);
      else void notifyBulkLeadAssignment(uid, info.count, emitToUser).catch(() => null);
    }

    const created = results.filter((r) => r.status === "created").length;
    const duplicate = results.filter((r) => r.status === "duplicate").length;
    const invalid = results.filter((r) => r.status === "invalid").length;

    // ── Auto-assign only leads that were NOT directly assigned to a counselor
    let assigned = 0;
    const unassignedIds = results
      .filter((r) => r.status === "created" && r.leadId)
      .map((r) => r.leadId as string)
      .filter((id) => {
        const idx = results.find((r) => r.leadId === id)!.index;
        return !rows[idx]?.assigned_to;
      });

    if (unassignedIds.length > 0) {
      try {
        const assignment = await leadService.autoAssignLeads(unassignedIds);
        assigned = assignment.assigned;
      } catch {
        // No active teams — leads stay unassigned, not a fatal error
      }
    }

    // One notice for the batch to the team leaders, Super Admins and the Sales Manager (2026-10-19).
    void announceNewLeads(results.filter((r) => r.status === "created" && r.leadId).map((r) => r.leadId as string));

    sendSuccess(
      res,
      `Batch processed: ${created} created, ${duplicate} skipped (duplicate), ${invalid} invalid`,
      {
        summary: {
          total: rows.length,
          created,
          duplicate,
          invalid,
          assignedToTeam: assigned,
        },
        results,
      },
      201,
    );
  } catch (err) {
    next(err);
  }
};
