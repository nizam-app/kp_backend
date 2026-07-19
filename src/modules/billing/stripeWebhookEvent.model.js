import mongoose from "mongoose";

const { Schema, model } = mongoose;

/**
 * Idempotency ledger for Stripe webhook delivery. Stripe delivers events
 * at-least-once, so we record each processed event id and skip duplicates.
 * `expiresAt` lets Mongo TTL-prune old rows after Stripe's practical dispute
 * and manual-redelivery window.
 */
const stripeWebhookEventSchema = new Schema(
  {
    eventId: { type: String, required: true, unique: true, index: true },
    type: { type: String, trim: true },
    accountId: { type: String, trim: true, index: true },
    objectId: { type: String, trim: true, index: true },
    status: {
      type: String,
      enum: ["PROCESSING", "PROCESSED"],
      default: "PROCESSING",
      index: true,
    },
    result: Schema.Types.Mixed,
    processedAt: Date,
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 400 * 24 * 60 * 60 * 1000),
      index: { expires: 0 },
    },
  },
  { versionKey: false }
);

export const StripeWebhookEvent = model(
  "StripeWebhookEvent",
  stripeWebhookEventSchema
);
