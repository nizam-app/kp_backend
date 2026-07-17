import mongoose from "mongoose";

const { Schema, model } = mongoose;

/**
 * Idempotency ledger for Stripe webhook delivery. Stripe delivers events
 * at-least-once, so we record each processed event id and skip duplicates.
 * `expiresAt` lets Mongo TTL-prune old rows (30 days) automatically.
 */
const stripeWebhookEventSchema = new Schema(
  {
    eventId: { type: String, required: true, unique: true, index: true },
    type: { type: String, trim: true },
    processedAt: { type: Date, default: Date.now },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      index: { expires: 0 },
    },
  },
  { versionKey: false }
);

export const StripeWebhookEvent = model(
  "StripeWebhookEvent",
  stripeWebhookEventSchema
);
