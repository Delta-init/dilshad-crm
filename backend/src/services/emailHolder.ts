import { Types } from "mongoose";
import { Student } from "../models/Student.js";
import { Lead } from "../models/Lead.js";
import { differentPeople, emailKey, emailMatch, madeUpEmail, type EmailHolder, type Person } from "../utils/clientEmail.js";

/** As many records with one address as are worth looking through — far more than any real share. */
const LOOK_AT = 1000;

const idOf = (v: unknown): Types.ObjectId | null => {
  const raw = v && typeof v === "object" && "_id" in v ? (v as { _id: unknown })._id : v;
  return raw && Types.ObjectId.isValid(String(raw)) ? new Types.ObjectId(String(raw)) : null;
};

/**
 * Who else in this CRM holds this email and is a different client (one email,
 * one client — the user, 2026-10-10) — or null when nobody does.
 *
 * Another student — not this one, nor a student of this same lead, who is the
 * same person — or another lead than this one, compared by phone (the last
 * nine digits), else by name (clientEmail.differentPeople). A student is named
 * before a lead, the earliest closed first: that is who finance filed the
 * email under. The address is compared trimmed and lower-cased, so an older
 * record stored another way still counts. A made-up email (noemail@…,
 * 2026-10-29) is held by nobody in particular and taken for everybody.
 */
export async function findEmailHolder(
  email: unknown,
  client: Person & { leadId?: unknown; studentId?: unknown },
): Promise<EmailHolder | null> {
  const key = emailKey(email);
  if (!key) return null;
  if (madeUpEmail(key)) return { kind: "made_up", id: "", name: key };
  const match = emailMatch(key);
  const leadId = idOf(client.leadId);
  const studentId = idOf(client.studentId);

  const students = await Student.find({
    email: match,
    ...(studentId ? { _id: { $ne: studentId } } : {}),
    ...(leadId ? { leadId: { $ne: leadId } } : {}),
  })
    .select("name phone enrollmentNumber")
    .sort({ createdAt: 1, _id: 1 })
    .limit(LOOK_AT)
    .lean();
  for (const s of students) {
    if (differentPeople(client, s)) return { kind: "student", id: String(s._id), name: s.name ?? "", code: s.enrollmentNumber };
  }

  const leads = await Lead.find({ email: match, ...(leadId ? { _id: { $ne: leadId } } : {}) })
    .select("name phone")
    .sort({ createdAt: 1, _id: 1 })
    .limit(LOOK_AT)
    .lean();
  for (const l of leads) {
    if (differentPeople(client, l)) return { kind: "lead", id: String(l._id), name: l.name ?? "" };
  }
  return null;
}
