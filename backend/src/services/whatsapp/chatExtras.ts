import { Types } from "mongoose";
import { CallLog } from "../../models/CallLog.js";
import { Lead } from "../../models/Lead.js";
import { LeadCall } from "../../models/LeadCall.js";
import { Student } from "../../models/Student.js";
import { User } from "../../models/User.js";
import { WhatsAppTag } from "../../models/WhatsAppMessage.js";
import { leadsByKey } from "./service.js";

/*
 * What a WhatsApp chat shows beside its messages (the owner, 2026-10-30): whether the person is a student — marked, or
 * enrolled — and their calls, with a call logged by hand from the chat. A student gets no automatic first reply or
 * follow-ups (followups.ts).
 */

/** Of these numbers (last 9 digits), the ones that are a student: marked so, or their lead has an enrolment. */
export async function studentKeys(keys: string[]): Promise<Map<string, "marked" | "enrolled">> {
  const out = new Map<string, "marked" | "enrolled">();
  const list = [...new Set(keys.filter((k) => /^\d{9}$/.test(k)))];
  if (!list.length) return out;
  const byKey = await leadsByKey();
  const leadOf = new Map(list.map((k) => [k, byKey.get(k)]).filter(([, id]) => !!id) as [string, Types.ObjectId][]);
  const enrolled = new Set((await Student.find({ leadId: { $in: [...new Set(leadOf.values())] } }).select("leadId").lean<{ leadId: Types.ObjectId }[]>())
    .map((s) => String(s.leadId)));
  for (const [k, id] of leadOf) if (enrolled.has(String(id))) out.set(k, "enrolled");
  for (const t of await WhatsAppTag.find({ key: { $in: list }, student: true }).select("key").lean()) out.set(t.key, "marked");
  return out;
}

export const isStudentKey = async (key: string) => (await studentKeys([key])).has(key);

/** The mark itself, with who set it — for the chat header. */
export async function studentMark(key: string): Promise<{ student: boolean; how: "marked" | "enrolled" | null; byName: string; at: Date | null }> {
  const how = (await studentKeys([key])).get(key) ?? null;
  const tag = how === "marked" ? await WhatsAppTag.findOne({ key }).lean() : null;
  return { student: !!how, how, byName: tag?.byName ?? "", at: tag?.at ?? null };
}

/** Mark a number a student, or not. (One with an enrolment stays a student whatever the mark says.) */
export async function setStudent(key: string, student: boolean, byUserId: string) {
  const by = await User.findById(byUserId).select("name").lean<{ name?: string } | null>();
  await WhatsAppTag.updateOne({ key }, { $set: { key, student, by: new Types.ObjectId(byUserId), byName: String(by?.name ?? ""), at: new Date() } }, { upsert: true });
  return studentMark(key);
}

/* ── Calls ──────────────────────────────────────────────────────────────── */

export type ChatCall = {
  id: string;
  kind: "3cx" | "logged" | "click";      // from 3CX; logged by hand; the CRM's Call button
  at: Date;
  direction: "in" | "out";
  answered: boolean;
  status: string;                        // answered | missed | no_answer
  talkSeconds: number;
  by: string;                            // who (the salesperson / agent)
  note: string;
  recordings: number;                    // 3CX recordings to play (calls/log/:id/recording-link)
  canDelete?: boolean;
};

const tailRegex = (key: string) => new RegExp(`${key.split("").join("\\D*")}(?!\\d)`);

/** A number's calls — 3CX's, the Call button's and those logged by hand — newest first, with counts. */
export async function chatCalls(key: string): Promise<{ calls: ChatCall[]; total: number; logged: number; answered: number }> {
  const leadId = (await leadsByKey()).get(key) ?? null;
  const [threecx, logs] = await Promise.all([
    LeadCall.find({ $or: [{ numberKey: key }, ...(leadId ? [{ lead: leadId }] : [])] }).sort({ startedAt: -1 }).limit(200).lean(),
    CallLog.find({ source: { $in: ["manual", "click_to_call"] }, $or: [{ phoneNumber: tailRegex(key) }, ...(leadId ? [{ leadId }] : [])] })
      .sort({ callDate: -1 }).limit(200).lean(),
  ]);
  const calls: ChatCall[] = [
    ...threecx.map((c) => ({
      id: String(c._id), kind: "3cx" as const, at: c.startedAt, direction: c.direction as "in" | "out",
      answered: c.status === "answered", status: c.status, talkSeconds: c.talkSeconds ?? 0,
      by: c.userName || c.agentName || "", note: "", recordings: (c.recordingIds ?? []).length || (c.recordingUrl ? 1 : 0),
    })),
    ...logs.map((c) => ({
      id: String(c._id), kind: (c.source === "manual" ? "logged" : "click") as "logged" | "click", at: c.callDate,
      direction: c.callDirection === "inbound" ? "in" as const : "out" as const,
      answered: c.callType === "Outbound" || c.callType === "Inbound",
      status: c.callType === "Notanswered" || c.callType === "Missed" ? "no_answer" : "answered",
      talkSeconds: c.callDuration ?? 0, by: c.agentName ?? "", note: c.note ?? "", recordings: 0,
    })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return { calls, total: calls.length, logged: logs.filter((c) => c.source === "manual").length, answered: calls.filter((c) => c.answered).length };
}

/**
 * A call logged by hand from a chat: one call out, by this person, now — counted like a call from the CRM's Call
 * button (the leaderboard's calls, and it keeps the lead off Inactive Leads).
 */
export async function logCall(key: string, phone: string, byUserId: string, answered: boolean, note: string) {
  const by = await User.findById(byUserId).select("name extension").lean<{ name?: string; extension?: string } | null>();
  const leadId = (await leadsByKey()).get(key) ?? null;
  const lead = leadId ? await Lead.findById(leadId).select("name").lean<{ name?: string } | null>() : null;
  const doc = await CallLog.create({
    leadId, contactName: lead?.name ?? null, phoneNumber: phone ? `+${phone}` : key,
    callType: answered ? "Outbound" : "Notanswered", callDirection: "outbound", callDuration: 0, callDate: new Date(),
    agentName: String(by?.name ?? ""), agentExtension: by?.extension ?? null, initiatedBy: new Types.ObjectId(byUserId),
    source: "manual", note: note || null,
  });
  if (leadId) {
    await Lead.updateOne({ _id: leadId }, {
      $set: { lastContactedAt: new Date() },
      $push: { activityLogs: {
        action: "call_logged", performedBy: new Types.ObjectId(byUserId), createdAt: new Date(),
        description: `Call logged by hand from WhatsApp — ${answered ? "answered" : "no answer"}${note ? `: ${note.slice(0, 300)}` : ""}`,
      } },
    });
  }
  return doc;
}
