import mongoose, { Schema, type Types } from "mongoose";

/*
 * One of finance's old-books invoices (2026-11-25) whose salesperson is one of this CRM's users — or nobody's here,
 * kept so the sync can say so. Copied from finance by services/oldBooks.ts; nothing here is typed by hand.
 *
 * `payments` are the ones that count here — paid on or after OLD_BOOKS_FROM, in the lead payments' shape, so the
 * revenue figures add them as they add a lead's (utils/bangaloreRevenue.ts bangaloreLeadsUnion). `allPayments` are
 * every payment finance has on it, for when it was paid in full (commission).
 */
export interface IOldBooksSale {
  _id: Types.ObjectId;
  /** Finance's invoice id — also the CommissionSale's `student` for it (one per invoice). */
  financeInvoiceId: Types.ObjectId;
  invoiceNumber: string;
  customerName: string;
  course: string;
  /** This CRM's course it earns under, by name (null: none — commission 0). */
  courseRef: Types.ObjectId | null;
  salespersonName: string;
  salespersonEmail: string;
  /** This CRM's user (null: the salesperson isn't one here). */
  assignedTo: Types.ObjectId | null;
  team: Types.ObjectId | null;
  fee: number;
  currency: string;
  issueDate: Date;
  status: string;
  balance: number;
  payments: { financeId: string; amount: number; paidAt: Date; method: string; note: string; oldBooks: true }[];
  allPayments: { financeId: string; amount: number; paidAt: Date }[];
  /** When the client finished paying, as finance has it (null while owing). */
  paidInFullAt: Date | null;
  syncedAt: Date;
}

const pay = { financeId: String, amount: Number, paidAt: Date, method: String, note: String, oldBooks: Boolean };

const oldBooksSaleSchema = new Schema<IOldBooksSale>(
  {
    financeInvoiceId: { type: Schema.Types.ObjectId, required: true, unique: true },
    invoiceNumber: { type: String, default: "" },
    customerName: { type: String, default: "" },
    course: { type: String, default: "" },
    courseRef: { type: Schema.Types.ObjectId, ref: "Course", default: null },
    salespersonName: { type: String, default: "" },
    salespersonEmail: { type: String, default: "" },
    assignedTo: { type: Schema.Types.ObjectId, ref: "User", default: null },
    team: { type: Schema.Types.ObjectId, ref: "Team", default: null },
    fee: { type: Number, default: 0 },
    currency: { type: String, default: "AED" },
    issueDate: { type: Date },
    status: { type: String, default: "" },
    balance: { type: Number, default: 0 },
    payments: { type: [new Schema(pay, { _id: false })], default: [] },
    allPayments: { type: [new Schema({ financeId: String, amount: Number, paidAt: Date }, { _id: false })], default: [] },
    paidInFullAt: { type: Date, default: null },
    syncedAt: { type: Date },
  },
  { timestamps: true, versionKey: false, collection: "oldbookssales" },
);

oldBooksSaleSchema.index({ assignedTo: 1, "payments.paidAt": 1 });

export const OldBooksSale = mongoose.model<IOldBooksSale>("OldBooksSale", oldBooksSaleSchema);
