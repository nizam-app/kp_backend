import mongoose from "mongoose";

const { Schema, model } = mongoose;

const disputeFinancialActionSchema = new Schema(
  {
    dispute: { type: Schema.Types.ObjectId, ref: "Dispute", required: true, index: true },
    invoice: { type: Schema.Types.ObjectId, ref: "Invoice", required: true, index: true },
    requestedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    approvedBy: { type: Schema.Types.ObjectId, ref: "User" },
    type: {
      type: String,
      enum: ["REFUND", "SERVICE_CREDIT", "CHARGEBACK_ADJUSTMENT"],
      required: true,
    },
    amountMinor: { type: Number, required: true, min: 0 },
    currency: { type: String, trim: true, default: "GBP" },
    status: {
      type: String,
      enum: ["PENDING_APPROVAL", "APPROVED", "PROCESSING", "SUCCEEDED", "FAILED"],
      default: "APPROVED",
      index: true,
    },
    idempotencyKey: { type: String, required: true, trim: true, unique: true },
    refund: { type: Schema.Types.ObjectId, ref: "Refund" },
    failureReason: { type: String, trim: true },
    processedAt: Date,
  },
  { timestamps: true }
);

disputeFinancialActionSchema.index({ dispute: 1, createdAt: -1 });

export const DisputeFinancialAction = model(
  "DisputeFinancialAction",
  disputeFinancialActionSchema
);
