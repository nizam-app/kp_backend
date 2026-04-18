import mongoose from "mongoose";

const { Schema, model } = mongoose;

const disputeSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    company: { type: Schema.Types.ObjectId, ref: "User", index: true },
    job: { type: Schema.Types.ObjectId, ref: "Job", index: true },
    invoice: { type: Schema.Types.ObjectId, ref: "Invoice", index: true },
    customerName: { type: String, trim: true },
    mechanic: { type: Schema.Types.ObjectId, ref: "User", index: true },
    serviceLabel: { type: String, trim: true },
    amount: { type: Number, min: 0, default: 0 },
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
      enum: ["OPEN", "IN_REVIEW", "RESOLVED", "CLOSED"],
      default: "OPEN",
      index: true,
    },
    notes: { type: String, trim: true },
    resolvedAt: Date,
  },
  { timestamps: true }
);

disputeSchema.index({ createdAt: -1 });
disputeSchema.index({ company: 1, status: 1 });
disputeSchema.index({ invoice: 1, createdAt: -1 });

export const Dispute = model("Dispute", disputeSchema);
