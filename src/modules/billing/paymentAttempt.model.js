import mongoose from "mongoose";

const { Schema, model } = mongoose;

const paymentAttemptEventSchema = new Schema(
  {
    source: {
      type: String,
      enum: ["APPROVAL", "SYNC", "WEBHOOK", "ADMIN"],
      required: true,
    },
    eventType: { type: String, trim: true },
    externalEventId: { type: String, trim: true },
    paymentStatus: { type: String, trim: true, required: true },
    processorStatus: { type: String, trim: true },
    message: { type: String, trim: true },
    occurredAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const paymentAttemptSchema = new Schema(
  {
    invoice: { type: Schema.Types.ObjectId, ref: "Invoice", index: true },
    job: { type: Schema.Types.ObjectId, ref: "Job", required: true, index: true },
    payer: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    payerRole: { type: String, trim: true, required: true },
    provider: { type: String, enum: ["STRIPE"], default: "STRIPE" },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, trim: true, default: "GBP" },
    paymentStatus: { type: String, trim: true, required: true },
    processorStatus: { type: String, trim: true },
    stripePaymentIntentId: { type: String, trim: true, required: true },
    stripePaymentMethodId: { type: String, trim: true },
    idempotencyKey: { type: String, trim: true },
    declineCode: { type: String, trim: true },
    failureMessage: { type: String, trim: true },
    completedAt: Date,
    events: { type: [paymentAttemptEventSchema], default: [] },
  },
  { timestamps: true }
);

paymentAttemptSchema.index(
  { stripePaymentIntentId: 1 },
  { unique: true, name: "uniq_payment_attempt_stripe_intent" }
);
paymentAttemptSchema.index({ job: 1, createdAt: -1 });

export const PaymentAttempt = model("PaymentAttempt", paymentAttemptSchema);
