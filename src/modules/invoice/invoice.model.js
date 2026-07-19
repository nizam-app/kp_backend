import mongoose from "mongoose";

const { Schema, model } = mongoose;

const invoiceLineItemSchema = new Schema(
  {
    description: { type: String, required: true, trim: true },
    quantity: { type: Number, default: 1, min: 0 },
    unitAmount: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const invoiceSchema = new Schema(
  {
    invoiceNo: { type: String, required: true, unique: true, index: true },
    job: { type: Schema.Types.ObjectId, ref: "Job", required: true },
    fleet: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    /** Supplier credited for the invoice: exactly one of company/mechanic. */
    company: { type: Schema.Types.ObjectId, ref: "User", index: true },
    mechanic: { type: Schema.Types.ObjectId, ref: "User", index: true },
    /** Technician who performed the work; never implies payout ownership. */
    performedByMechanic: { type: Schema.Types.ObjectId, ref: "User", index: true },
    subtotal: { type: Number, required: true, min: 0 },
    vatAmount: { type: Number, default: 0, min: 0 },
    vatRate: { type: Number, default: 0, min: 0 },
    vatApplied: { type: Boolean, default: false },
    totalAmount: { type: Number, required: true, min: 0 },
    currency: { type: String, trim: true, default: "GBP" },
    /** Snapshot of platform fee % at invoice creation (e.g. 12). */
    platformFeePercent: { type: Number, min: 0, max: 100 },
    status: {
      type: String,
      enum: [
        "DRAFT",
        "ISSUED",
        "PAID",
        "FAILED",
        "PARTIALLY_REFUNDED",
        "REFUNDED",
        "VOID",
      ],
      default: "ISSUED",
      index: true,
    },
    issuedAt: { type: Date, default: Date.now },
    paidAt: Date,
    dueAt: { type: Date, index: true },
    collections: {
      state: {
        type: String,
        enum: ["CURRENT", "ACTION_REQUIRED", "OVERDUE", "ESCALATED", "RESOLVED"],
        default: "CURRENT",
        index: true,
      },
      reminderCount: { type: Number, min: 0, default: 0 },
      lastReminderAt: Date,
      nextReminderAt: { type: Date, index: true },
    },
    payment: {
      provider: { type: String, trim: true, default: "MANUAL" },
      status: {
        type: String,
        enum: [
          "PENDING",
          "REQUIRES_PAYMENT_METHOD",
          "REQUIRES_ACTION",
          "PROCESSING",
          "SUCCEEDED",
          "FAILED",
          "CANCELED",
          "PARTIALLY_REFUNDED",
          "REFUNDED",
        ],
        default: "PENDING",
      },
      stripeCustomerId: { type: String, trim: true },
      stripePaymentMethodId: { type: String, trim: true },
      stripePaymentIntentId: { type: String, trim: true },
      stripeChargeId: { type: String, trim: true },
      stripeTransferId: { type: String, trim: true },
      transferStatus: { type: String, trim: true },
      transferFailureCode: { type: String, trim: true },
      transferFailureMessage: { type: String, trim: true },
      transferUpdatedAt: Date,
      lastError: { type: String, trim: true },
      disputeStatus: { type: String, trim: true },
      authorizedAmount: { type: Number, min: 0 },
      capturedAmount: { type: Number, min: 0 },
      refundedAmount: { type: Number, min: 0, default: 0 },
      lastRefundAt: Date,
      updatedAt: Date,
    },
    pdfUrl: { type: String, trim: true },
    lineItems: {
      type: [invoiceLineItemSchema],
      default: [],
    },
    billedToSnapshot: {
      companyName: { type: String, trim: true },
      vatNumber: { type: String, trim: true },
      address: { type: String, trim: true },
    },
    mechanicSnapshot: {
      displayName: { type: String, trim: true },
      businessName: { type: String, trim: true },
      rating: { type: Number, min: 0, max: 5 },
      profilePhotoUrl: { type: String, trim: true },
    },
    supplierSnapshot: {
      supplierType: { type: String, enum: ["MECHANIC", "COMPANY"] },
      supplierId: { type: Schema.Types.ObjectId, ref: "User" },
      name: { type: String, trim: true },
      vatRegistered: { type: Boolean, default: false },
      vatNumber: { type: String, trim: true },
    },
  },
  { timestamps: true }
);

invoiceSchema.pre("validate", function validateSupplierCredit() {
  if (Boolean(this.company) === Boolean(this.mechanic)) {
    this.invalidate(
      "company",
      "Invoice must credit exactly one company or independent mechanic"
    );
  }
});

invoiceSchema.index({ fleet: 1, createdAt: -1 });
invoiceSchema.index({ company: 1, createdAt: -1 });
invoiceSchema.index({ mechanic: 1, createdAt: -1 });
invoiceSchema.index({ job: 1 }, { unique: true, name: "uniq_invoice_job" });

export const Invoice = model("Invoice", invoiceSchema);
