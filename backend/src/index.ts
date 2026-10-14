import "dotenv/config";
import { createServer } from "http";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { connectDB } from "./config/database.js";
import { env } from "./config/env.js";
import routes from "./routes/index.js";
import { errorHandler, notFound } from "./middleware/errorHandler.js";
import { initSocket } from "./socket.js";
import { startReminderScheduler } from "./services/reminderScheduler.js";
import { startSplitScheduler } from "./services/splitScheduler.js";
import { startFinanceHandoverWorker } from "./services/financeHandoverWorker.js";
import { startFollowupWarningScheduler } from "./services/followupWarningScheduler.js";
import { startBackupScheduler } from "./services/backupService.js";
import { startInactiveLeadScheduler } from "./services/inactiveLeadScheduler.js";
import { startIdleAlertScheduler } from "./services/idleAlertScheduler.js";
import { startMeetingReminderScheduler } from "./services/meetingReminderScheduler.js";
import { startCallSyncWorker } from "./services/callSyncService.js";

const app = express();

// ─── Security & Parsing Middleware ────────────────────────────────────────────
app.use(helmet());
app.use(
  cors({
    origin: [env.CLIENT_URL, "http://localhost:3001", "http://localhost:19006"],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

if (env.NODE_ENV === "development") {
  app.use(morgan("dev"));
}

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use("/api/v1", routes);

// ─── 404 & Error Handlers ─────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ─── Start Server ─────────────────────────────────────────────────────────────
const start = async () => {
  await connectDB();
  const httpServer = createServer(app);
  initSocket(httpServer);
  httpServer.listen(env.PORT, () => {
    console.log(`🚀 Server running on http://localhost:${env.PORT} [${env.NODE_ENV}]`);
    console.log(`📋 API Base: http://localhost:${env.PORT}/api/v1`);
    // Start after server is listening so Socket.IO is ready for emitToUser.
    // Off in a second process against the same database: these assign leads and
    // notify people on a timer, and two of them do it twice.
    if (env.RUN_SCHEDULERS) {
      startReminderScheduler();
      startSplitScheduler();
      startFollowupWarningScheduler();
      startBackupScheduler();
      startInactiveLeadScheduler();
      startIdleAlertScheduler();
      startMeetingReminderScheduler();
    } else {
      console.log("⏸️  RUN_SCHEDULERS=false — the timed jobs are not running in this process");
    }
    // Outside the gate: idempotent on the CRM's own id, and usually the reason
    // a local copy is pointed at real data in the first place.
    startFinanceHandoverWorker();
    // 3CX calls with leads, every minute (off without THREECX_* or with RUN_SCHEDULERS=false).
    startCallSyncWorker();
  });
};

start();

export default app;
