import { Types } from "mongoose";
import { AppSetting } from "../models/AppSetting.js";
import type { IAppSettings } from "../types/index.js";
import type { UpdateAppSettingsInput } from "../validations/settingsValidation.js";

/**
 * The CRM's settings document, read and written.
 *
 * Read through a 30-second cache: the schedulers ask on every tick, and a
 * change on the Settings page reaching them within half a minute is soon
 * enough. Writing clears the cache, so the page itself always sees what it
 * just saved.
 */

export type AppSettingsDTO = Omit<IAppSettings, "inactiveLeads" | "updatedBy" | "updatedAt"> & {
  inactiveLeads: Omit<IAppSettings["inactiveLeads"], "enabledAt"> & { enabledAt: string | null };
  updatedBy: string | null;
  updatedAt: string | null;
};

const TTL_MS = 30_000;
let cache: { at: number; value: AppSettingsDTO } | null = null;

function toDTO(doc: IAppSettings): AppSettingsDTO {
  return {
    key: "app",
    inactiveLeads: {
      autoReassign: doc.inactiveLeads.autoReassign,
      limitMinutes: doc.inactiveLeads.limitMinutes,
      enabledAt: doc.inactiveLeads.enabledAt ? new Date(doc.inactiveLeads.enabledAt).toISOString() : null,
    },
    idleAlerts: {
      enabled: doc.idleAlerts.enabled,
      limitMinutes: doc.idleAlerts.limitMinutes,
      notifyTeamLeaders: doc.idleAlerts.notifyTeamLeaders,
    },
    workingHours: {
      timezone: doc.workingHours.timezone,
      days: [...doc.workingHours.days].sort((a, b) => a - b),
      start: doc.workingHours.start,
      end: doc.workingHours.end,
    },
    email: { inactiveLeads: doc.email.inactiveLeads, idleAlerts: doc.email.idleAlerts, meetings: doc.email.meetings },
    updatedBy: doc.updatedBy ? String(doc.updatedBy) : null,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
  };
}

/** The settings, with every default filled in. The document is created the first time anyone asks. */
export async function getAppSettings(): Promise<AppSettingsDTO> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  // Read first: an upsert on every read would stamp updatedAt, and "last saved" would mean "last read".
  let doc = await AppSetting.findOne({ key: "app" }).lean<IAppSettings>();
  if (!doc) {
    doc = await AppSetting.findOneAndUpdate(
      { key: "app" },
      { $setOnInsert: { key: "app" } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean<IAppSettings>();
  }
  const value = toDTO(doc!);
  cache = { at: Date.now(), value };
  return value;
}

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

export async function updateAppSettings(input: UpdateAppSettingsInput, userId: string): Promise<AppSettingsDTO> {
  // Read past the cache: whether the switch is flipping is decided on what is stored now.
  cache = null;
  const current = await getAppSettings();

  // Start and end may arrive separately; they are checked against each other as they will be stored.
  const start = input.workingHours?.start ?? current.workingHours.start;
  const end = input.workingHours?.end ?? current.workingHours.end;
  if (minutesOf(end) <= minutesOf(start)) {
    throw Object.assign(new Error("Working hours must end after they start"), { statusCode: 400 });
  }

  const set: Record<string, unknown> = { updatedBy: new Types.ObjectId(userId) };
  for (const [group, values] of Object.entries(input)) {
    if (!values) continue;
    for (const [field, value] of Object.entries(values)) {
      if (value === undefined) continue;
      set[`${group}.${field}`] = field === "days" ? [...new Set(value as number[])].sort((a, b) => a - b) : value;
    }
  }

  // Automatic moves count from the moment they are switched on — never the backlog before it.
  const autoReassign = input.inactiveLeads?.autoReassign;
  if (autoReassign !== undefined && autoReassign !== current.inactiveLeads.autoReassign) {
    set["inactiveLeads.enabledAt"] = autoReassign ? new Date() : null;
  }
  // Nothing to save: not a save (nor a new "updated by").
  if (Object.keys(set).length === 1) return current;

  // A start or an end sent alone is checked against the other as it is stored at the moment of writing, so two
  // such saves at once can't leave the hours ending before they start.
  const guard: Record<string, unknown> = {};
  const wh = input.workingHours;
  if (wh?.start !== undefined && wh.end === undefined) guard["workingHours.end"] = { $gt: wh.start };
  if (wh?.end !== undefined && wh.start === undefined) guard["workingHours.start"] = { $lt: wh.end };

  const doc = await AppSetting.findOneAndUpdate(
    { key: "app", ...guard },
    { $set: set },
    { new: true, runValidators: true }
  ).lean<IAppSettings>();
  cache = null;
  if (!doc) throw Object.assign(new Error("Working hours must end after they start"), { statusCode: 400 });
  return toDTO(doc);
}

/**
 * Whether a moment falls inside the working hours — in their own time zone,
 * not the server's. The inactive-lead clock and the idle alerts only run
 * inside them, so nobody is flagged for a lead that landed at midnight.
 */
export function isWithinWorkingHours(settings: Pick<AppSettingsDTO, "workingHours">, at: Date = new Date()): boolean {
  const { timezone, days, start, end } = settings.workingHours;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const minutes = (Number(get("hour")) % 24) * 60 + Number(get("minute"));
  return days.includes(weekday) && minutes >= minutesOf(start) && minutes < minutesOf(end);
}
