import { Types } from "mongoose";
import { Notification } from "../models/Notification.js";
import { User } from "../models/User.js";
import { Role } from "../models/Role.js";
import { emitToUser } from "../socket.js";
import { sendPushToUsers } from "./pushService.js";
import { renderEmail, sendMail, type MailCalendarInvite } from "./mailService.js";
import { getAppSettings } from "./settingsService.js";
import type { EmailEventKey, INotification, NotificationDTO } from "../types/index.js";

/**
 * One call to tell people something, every way the CRM can:
 *
 *   1. kept as a notification, so the bell still shows it after a reload;
 *   2. live on the socket, as the same "notification" event the bell has
 *      always listened for (now carrying the stored id);
 *   3. as a web push, for a phone in a pocket;
 *   4. by email — when the event asks for it and that kind of email is
 *      switched on in Settings.
 *
 * It never throws. Telling people is a courtesy on top of something that
 * already happened — a lead moved, a meeting booked — and a mail server or a
 * push service having a bad minute must not undo it.
 */

export interface NotifyEmail {
  subject: string;
  heading?: string;
  /** Plain text; one paragraph each. "Hi <name>," is added per person. */
  paragraphs: string[];
  actionLabel?: string;
  /** A calendar invite for each person — made per person, so each lists only them. */
  invite?: (person: { name: string; email: string }) => MailCalendarInvite;
}

export interface NotifyInput {
  userIds: Array<string | Types.ObjectId>;
  /** e.g. "inactive_lead", "idle_alert", "meeting". The bell picks its icon from it. */
  type: string;
  title: string;
  body: string;
  /** Where the notice leads, as an app path: "/leads/123". */
  url?: string;
  /** Collapses repeat pushes about the same thing into one on the phone. */
  tag?: string;
  /** Send an email too — only if the Settings switch for this kind of email is on. */
  email?: NotifyEmail & { setting: EmailEventKey };
}

/** Every active Super Admin — who hears about inactive leads and idle people. */
export async function superAdminIds(): Promise<string[]> {
  const roles = await Role.find({ isSystemRole: true, roleName: "Super Admin" }).select("_id").lean();
  if (!roles.length) return [];
  const admins = await User.find({ role: { $in: roles.map((r) => r._id) }, status: { $ne: "inactive" } })
    .select("_id")
    .lean();
  return admins.map((a) => String(a._id));
}

export function toNotificationDTO(n: Pick<INotification, "_id" | "type" | "title" | "body" | "url" | "readAt" | "createdAt">): NotificationDTO {
  return {
    id: String(n._id),
    type: n.type,
    title: n.title,
    body: n.body,
    url: n.url,
    read: Boolean(n.readAt),
    createdAt: new Date(n.createdAt).toISOString(),
  };
}

export async function notify(input: NotifyInput): Promise<void> {
  const userIds = [...new Set(input.userIds.map(String))].filter((id) => Types.ObjectId.isValid(id));
  if (!userIds.length) return;
  // Cut to what the record holds: a lead's name has no limit, and one too long must not lose the whole notice.
  const title = input.title.slice(0, 200);
  const body = input.body.slice(0, 1000);
  const url = (input.url ?? "").slice(0, 500);

  // 1 + 2 — the record, and the live copy carrying its id.
  try {
    const docs = await Notification.insertMany(
      userIds.map((user) => ({ user, type: input.type, title, body, url }))
    );
    for (const doc of docs) {
      emitToUser(String(doc.user), "notification", toNotificationDTO(doc));
    }
  } catch (err) {
    console.error(`🔔 Could not store "${input.type}" notifications:`, err instanceof Error ? err.message : err);
  }

  // 3 — the phone.
  sendPushToUsers(userIds, {
    title,
    body,
    url: url || undefined,
    tag: input.tag,
    data: { type: input.type },
  }).catch((err) => console.error(`🔔 Push for "${input.type}" failed:`, err instanceof Error ? err.message : err));

  // 4 — email, when asked for and allowed.
  if (!input.email) return;
  try {
    const settings = await getAppSettings();
    if (!settings.email[input.email.setting]) return;
    const people = await User.find({ _id: { $in: userIds }, status: { $ne: "inactive" } })
      .select("name email")
      .lean<Array<{ _id: Types.ObjectId; name?: string; email?: string }>>();
    const email = input.email;
    await Promise.allSettled(
      people
        .filter((p) => p.email)
        .map((p) =>
          sendMail({
            to: p.email!,
            subject: email.subject,
            html: renderEmail({
              heading: email.heading ?? input.title,
              paragraphs: [`Hi ${p.name ?? "there"},`, ...email.paragraphs],
              action: input.url ? { label: email.actionLabel ?? "Open in Remote CRM", url: input.url } : undefined,
            }),
            icalEvent: email.invite?.({ name: p.name ?? "", email: p.email! }),
          })
        )
    );
  } catch (err) {
    console.error(`✉️  Emails for "${input.type}" failed:`, err instanceof Error ? err.message : err);
  }
}
