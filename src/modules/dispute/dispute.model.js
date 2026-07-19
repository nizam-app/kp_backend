import mongoose from "mongoose";

const { Schema, model } = mongoose;

const disputeSchema = new Schema(
  {
    caseNo: { type: String, trim: true, unique: true, sparse: true, index: true },
    caseType: {
      type: String,
      enum: ["SERVICE_DISPUTE", "STRIPE_CHARGEBACK"],
      default: "SERVICE_DISPUTE",
      index: true,
    },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    reasonCode: {
      type: String,
      enum: [
        "QUALITY",
        "INCORRECT_PARTS",
        "OVERCHARGE",
        "DAMAGE",
        "NO_SHOW",
        "PAYMENT",
        "CHARGEBACK",
        "OTHER",
      ],
      default: "OTHER",
      index: true,
    },
    claimant: { type: Schema.Types.ObjectId, ref: "User", index: true },
    claimantRole: { type: String, trim: true },
    respondent: { type: Schema.Types.ObjectId, ref: "User", index: true },
    respondentRole: { type: String, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    company: { type: Schema.Types.ObjectId, ref: "User", index: true },
    job: { type: Schema.Types.ObjectId, ref: "Job", index: true },
    invoice: { type: Schema.Types.ObjectId, ref: "Invoice", index: true },
    customerName: { type: String, trim: true },
    mechanic: { type: Schema.Types.ObjectId, ref: "User", index: true },
    serviceLabel: { type: String, trim: true },
    amount: { type: Number, min: 0, default: 0 },
    amountMinor: { type: Number, min: 0, default: 0 },
    currency: { type: String, trim: true, default: "GBP" },
    reason: { type: String, trim: true },
    priority: {
      type: String,
      enum: ["LOW", "MEDIUM", "HIGH"],
      default: "MEDIUM",
      index: true,
    },
    status: {
      type: String,
      enum: [
        "OPEN",
        "TRIAGE",
        "AWAITING_CUSTOMER_EVIDENCE",
        "AWAITING_PROVIDER_EVIDENCE",
        "INVESTIGATING",
        "DECISION_PENDING",
        "RESOLVED",
        "CLOSED",
        "APPEALED",
        "ESCALATED",
        "IN_REVIEW",
      ],
      default: "OPEN",
      index: true,
    },
    versionNumber: { type: Number, min: 1, default: 1 },
    assignedTo: { type: Schema.Types.ObjectId, ref: "User", index: true },
    assignedTeam: { type: String, trim: true, default: "DISPUTES" },
    responseDueAt: { type: Date, index: true },
    evidenceDueAt: { type: Date, index: true },
    decisionDueAt: { type: Date, index: true },
    nextActionOwner: {
      type: String,
      enum: ["CLAIMANT", "RESPONDENT", "ADMIN", "STRIPE", "NONE"],
      default: "ADMIN",
    },
    processorStatus: { type: String, trim: true, default: "NONE", index: true },
    stripeDisputeId: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
      index: true,
    },
    stripeChargeId: { type: String, trim: true },
    stripePaymentIntentId: { type: String, trim: true },
    stripeEvidenceDueAt: Date,
    financialState: {
      type: String,
      enum: [
        "NO_ACTION",
        "REFUND_PENDING",
        "PARTIALLY_ADJUSTED",
        "FULLY_ADJUSTED",
        "RECONCILED",
      ],
      default: "NO_ACTION",
      index: true,
    },
    decision: {
      outcome: {
        type: String,
        enum: [
          "NO_ACTION",
          "PARTIAL_REFUND",
          "FULL_REFUND",
          "REATTENDANCE",
          "SERVICE_CREDIT",
        ],
      },
      findings: { type: String, trim: true },
      rationale: { type: String, trim: true },
      amountMinor: { type: Number, min: 0 },
      decidedBy: { type: Schema.Types.ObjectId, ref: "User" },
      decidedAt: Date,
      idempotencyKey: { type: String, trim: true },
    },
    appeal: {
      requestedBy: { type: Schema.Types.ObjectId, ref: "User" },
      reason: { type: String, trim: true },
      requestedAt: Date,
    },
    supportTicket: { type: Schema.Types.ObjectId, ref: "SupportTicket", index: true },
    legalHold: {
      active: { type: Boolean, default: false },
      reason: { type: String, trim: true },
      setBy: { type: Schema.Types.ObjectId, ref: "User" },
      setAt: Date,
    },
    notes: { type: String, trim: true },
    resolvedAt: Date,
    resolvedBy: { type: Schema.Types.ObjectId, ref: "User" },
    closedAt: Date,
  },
  { timestamps: true }
);

disputeSchema.index({ createdAt: -1 });
disputeSchema.index({ company: 1, status: 1 });
disputeSchema.index({ invoice: 1, createdAt: -1 });
disputeSchema.index({ claimant: 1, updatedAt: -1 });
disputeSchema.index({ respondent: 1, updatedAt: -1 });
disputeSchema.index({ assignedTo: 1, status: 1, decisionDueAt: 1 });
disputeSchema.index({ job: 1, reasonCode: 1, status: 1 });

export const Dispute = model("Dispute", disputeSchema);
