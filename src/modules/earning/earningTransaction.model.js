import mongoose from "mongoose";

const { Schema, model } = mongoose;

const earningTransactionSchema = new Schema(
  {
    mechanic: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    job: { type: Schema.Types.ObjectId, ref: "Job", required: true, index: true },
    quote: { type: Schema.Types.ObjectId, ref: "Quote" },
    invoice: { type: Schema.Types.ObjectId, ref: "Invoice", index: true },
    refund: { type: Schema.Types.ObjectId, ref: "Refund", index: true },
    type: {
      type: String,
      enum: ["JOB_PAYMENT", "CANCELLATION_FEE", "ADJUSTMENT"],
      default: "JOB_PAYMENT",
    },
    /** ADJUSTMENT rows may be negative; original JOB_PAYMENT rows remain positive. */
    grossAmount: { type: Number, required: true },
    platformFee: { type: Number, default: 0 },
    /** Snapshot of platform fee % when the earning was created (e.g. 12). */
    platformFeePercent: { type: Number, min: 0, max: 100 },
    netAmount: { type: Number, required: true },
    currency: { type: String, trim: true, default: "GBP" },
    paidAt: { type: Date, default: Date.now, index: true },
    notes: { type: String, trim: true },
  },
  { timestamps: true }
);

earningTransactionSchema.pre("validate", function validateSignedAmounts() {
  if (
    this.type !== "ADJUSTMENT" &&
    [this.grossAmount, this.platformFee, this.netAmount].some(
      (value) => Number(value) < 0
    )
  ) {
    this.invalidate(
      "netAmount",
      "Only ADJUSTMENT transactions may contain negative amounts"
    );
  }
});

earningTransactionSchema.index({ mechanic: 1, paidAt: -1 });
earningTransactionSchema.index(
  { job: 1, mechanic: 1 },
  {
    unique: true,
    partialFilterExpression: { type: "JOB_PAYMENT" },
    name: "uniq_job_payment_per_mechanic",
  }
);
earningTransactionSchema.index(
  { refund: 1 },
  {
    unique: true,
    partialFilterExpression: { refund: { $type: "objectId" } },
    name: "uniq_earning_adjustment_refund",
  }
);

export const EarningTransaction = model(
  "EarningTransaction",
  earningTransactionSchema
);

