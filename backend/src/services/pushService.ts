import webpush from "web-push";
import { PushSubscription } from "../models/PushSubscription.js";
import { env } from "../config/env.js";

// ── Configure VAPID once ──────────────────────────────────────────────────────
webpush.setVapidDetails(
  env.VAPID_SUBJECT,
  env.VAPID_PUBLIC_KEY,
  env.VAPID_PRIVATE_KEY
);

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  tag?: string;
  url?: string;
  data?: Record<string, unknown>;
}

// ── Send push to a single user ────────────────────────────────────────────────
/** To every device the user enabled notifications on; how many there were, and how many took it. */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<{ devices: number; delivered: number }> {
  const subs = await PushSubscription.find({ userId });
  if (!subs.length) return { devices: 0, delivered: 0 };

  const json = JSON.stringify(payload);
  let delivered = 0;

  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          json
        );
        delivered++;
      } catch (err: unknown) {
        const code = (err as { statusCode?: number }).statusCode;
        const host = (sub.endpoint.match(/^https:\/\/([^/]+)/) || [])[1];
        if (code === 404 || code === 410) {
          // 404 / 410 = subscription gone, remove it
          await PushSubscription.deleteOne({ _id: sub._id });
        } else if (code === 403) {
          // Made with another VAPID key (the keys were changed): it can never be
          // delivered to with this one. The website registers the device again,
          // with this key, the next time it is opened.
          await PushSubscription.deleteOne({ _id: sub._id });
          console.error(`[push] dropped a device made with another VAPID key user=${userId} host=${host}: ${(err as Error).message}`);
        } else {
          // Anything else (413, network…) used to be swallowed, leaving no
          // trace of why nobody got notified
          console.error(`[push] send failed user=${userId} host=${host} status=${code ?? "n/a"}: ${(err as Error).message}`);
        }
      }
    })
  );
  return { devices: subs.length, delivered };
}

// ── Send push to multiple users ───────────────────────────────────────────────
export async function sendPushToUsers(userIds: string[], payload: PushPayload): Promise<void> {
  await Promise.allSettled(userIds.map((uid) => sendPushToUser(uid, payload)));
}

/**
 * Notify a user that a lead was assigned to them. Fire-and-forget.
 *
 * Since 2026-10-19 this goes through leadAlertService: kept in the bell (it used to be live only and gone on a
 * reload), live on the socket and pushed — and inside a bulk action (collectAssignments) one notice per person for
 * the whole batch. `emitFn` is no longer used; kept so every caller stays as it was.
 */
export async function notifyLeadAssignment(
  assignedUserId: string,
  leadId: string,
  leadName: string,
  _emitFn?: (userId: string, event: string, payload: object) => void,
): Promise<void> {
  const { announceAssignment } = await import("./leadAlertService.js");
  await announceAssignment(assignedUserId, leadId, leadName);
}

/** Notify a user about multiple leads assigned to them (bulk). */
export async function notifyBulkLeadAssignment(
  assignedUserId: string,
  count: number,
  _emitFn?: (userId: string, event: string, payload: object) => void,
): Promise<void> {
  const { announceBulkAssignment } = await import("./leadAlertService.js");
  await announceBulkAssignment(assignedUserId, count);
}

/**
 * Tell a counsellor that finance sent one of their enrolments back.
 *
 * The one thing on the enrolments screen that is waiting on *them*, so it is
 * the one thing worth interrupting them about. The reason travels in the body:
 * "sent back" on its own only prompts the question this is meant to answer.
 *
 * Fire-and-forget, and it must stay that way — this runs inside a background
 * sweep, and a push that fails is not a reason to stop recording what finance
 * decided.
 */
export async function notifyEnrolmentReturned(
  userId: string,
  studentId: string,
  studentName: string,
  reason: string,
): Promise<void> {
  const payload: PushPayload = {
    title: "An enrolment was sent back",
    body: reason
      ? `${studentName}: ${reason}`
      : `${studentName} — finance gave no reason. Ask them before resending.`,
    // Keyed on the enrolment, so a second send-back replaces the first notice
    // rather than stacking another one beside it.
    tag: `enrolment-returned-${studentId}`,
    url: "/enrolments",
    data: { type: "enrolment_returned", studentId },
  };

  try {
    const { emitToUser } = await import("../socket.js");
    emitToUser(userId, "notification", { ...payload, createdAt: new Date().toISOString() });
  } catch {
    // No socket server in this process; the push below is the message.
  }
  await sendPushToUser(userId, payload);
}
