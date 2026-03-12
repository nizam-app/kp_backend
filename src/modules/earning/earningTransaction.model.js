import mongoose from "mongoose";

const { Schema, model } = mongoose;

const earningTransactionSchema = new Schema(
  {
    mechanic: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    job: { type: Schema.Types.ObjectId, ref: "Job", required: true, index: true },
    quote: { type: Schema.Types.ObjectId, ref: "Quote" },
    type: {
      type: String,
      enum: ["JOB_PAYMENT", "CANCELLATION_FEE", "ADJUSTMENT"],
      default: "JOB_PAYMENT",
    },
    grossAmount: { type: Number, required: true, min: 0 },
    platformFee: { type: Number, default: 0, min: 0 },
    netAmount: { type: Number, required: true, min: 0 },
    currency: { type: String, trim: true, default: "GBP" },
    paidAt: { type: Date, default: Date.now, index: true },
    notes: { type: String, trim: true },
  },
  { timestamps: true }
);

earningTransactionSchema.index({ mechanic: 1, paidAt: -1 });
earningTransactionSchema.index({ job: 1, mechanic: 1 }, { unique: true });

export const EarningTransaction = model(
  "EarningTransaction",
  earningTransactionSchema
);

