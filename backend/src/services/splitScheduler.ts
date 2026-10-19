/**
 * Split Scheduler
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs every 60 seconds.
 *
 * For each team where settings.autoAssign === true AND settings.splitTime is
 * set (HH:mm AED/GST), checks if the current AED time matches. If it does and
 * the team has not already been split in this minute (lastSplitAt), it
 * auto-assigns all unassigned leads belonging to that team.
 */

import { Team } from "../models/Team.js";
import { Lead } from "../models/Lead.js";
import { autoSplitLeadPublic } from "./leadService.js";
import { collectAssignments } from "./leadAlertService.js";

const INTERVAL_MS = 60_000; // every 60 seconds

function currentAEDHHMM(): string {
  return new Date().toLocaleTimeString("en-GB", {
    timeZone: "Asia/Dubai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

async function tick() {
  try {
    const nowHHMM = currentAEDHHMM();
    const nowMinus1Min = new Date(Date.now() - 60_000);

    // Find teams that should split at this minute and haven't run yet
    const teams = await Team.find({
      status: "active",
      "settings.autoAssign": true,
      "settings.splitTime": nowHHMM,
      "settings.splitStrategy": { $ne: "live" }, // live teams assign instantly — no daily batch
      $or: [
        { "settings.lastSplitAt": null },
        { "settings.lastSplitAt": { $lt: nowMinus1Min } },
      ],
    })
      .select("_id name")
      .lean();

    for (const team of teams) {
      const teamId = team._id.toString();

      // Find all unassigned leads in this team
      const unassignedLeads = await Lead.find({
        team: team._id,
        assignedTo: null,
      })
        .select("_id")
        .lean();

      if (unassignedLeads.length === 0) {
        // Still stamp lastSplitAt so we don't re-check every second within the minute
        await Team.updateOne(
          { _id: team._id },
          { $set: { "settings.lastSplitAt": new Date() } },
        );
        continue;
      }

      // Stamp first so concurrent ticks don't double-fire
      await Team.updateOne(
        { _id: team._id },
        { $set: { "settings.lastSplitAt": new Date() } },
      );

      await collectAssignments(async () => {
        for (const lead of unassignedLeads) {
          // bypassSplitTime=true: the gate in autoSplitLead that holds leads when
          // splitTime is configured must be skipped here — we ARE the scheduler.
          await autoSplitLeadPublic(teamId, lead._id.toString(), "system", undefined, true);
        }
      });

      console.log(
        `[splitScheduler] ${team.name}: assigned ${unassignedLeads.length} leads at ${nowHHMM} GST`,
      );
    }
  } catch (err) {
    console.error("[splitScheduler] tick error:", err);
  }
}

export function startSplitScheduler() {
  console.log("⏰ Split scheduler started (checks every 60 s)");
  setInterval(tick, INTERVAL_MS);
}
