import mongoose from "mongoose";

const { Schema, model } = mongoose;

const refundSchema = new Schema(
  {
    invoice: { type: Schema.Types.ObjectId, ref: "Invoice", required: true, index: true },
    job: { type: Schema.Types.ObjectId, ref: "Job", required: true, index: true },
    mechanic: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    initiatedBy: { type: Schema.Types.ObjectId, ref: "User", index: true },
    provider: { type: String, enum: ["STRIPE"], default: "STRIPE" },
    stripeRefundId: { type: String, trim: true, required: true },
    stripePaymentIntentId: { type: String, trim: true, required: true, index: true },
    amount: { type: Number, required: true, min: 0.01 },
    currency: { type: String, trim: true, default: "GBP" },
    reason: { type: String, trim: true, required: true },
    status: {
      type: String,
      enum: ["PENDING", "SUCCEEDED", "FAILED", "CANCELED"],
      default: "PENDING",
      index: true,
    },
    source: { type: String, enum: ["ADMIN", "WEBHOOK"], required: true },
    failureReason: { type: String, trim: true },
    processedAt: Date,
  },
  { timestamps: true }
);

refundSchema.index(
  { stripeRefundId: 1 },
  { unique: true, name: "uniq_stripe_refund" }
);
refundSchema.index({ invoice: 1, createdAt: -1 });

export const Refund = model("Refund", refundSchema);
