import mongoose from "mongoose";
import {
  QUOTE_AVAILABILITY,
  QUOTE_STATUS,
  quoteAvailabilityValues,
  quoteStatusValues,
} from "../../constants/domain.js";

const { Schema, model } = mongoose;

const quoteSchema = new Schema(
  {
    job: { type: Schema.Types.ObjectId, ref: "Job", required: true, index: true },
    fleet: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    mechanic: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    company: { type: Schema.Types.ObjectId, ref: "User", index: true },
    submittedBy: { type: Schema.Types.ObjectId, ref: "User" },
    amount: { type: Number, required: true, min: 0 },
    notes: { type: String, trim: true },
    availabilityType: {
      type: String,
      enum: quoteAvailabilityValues,
      default: QUOTE_AVAILABILITY.NOW,
    },
    scheduledAt: Date,
    etaMinutes: { type: Number, min: 0 },
    currency: { type: String, trim: true, default: "GBP" },
    status: {
      type: String,
      enum: quoteStatusValues,
      default: QUOTE_STATUS.WAITING,
      index: true,
    },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 30 * 60 * 1000),
      index: true,
    },
    acceptedAt: Date,
    declinedAt: Date,
    expiredAt: Date,
    withdrawnAt: Date,
  },
  { timestamps: true }
);

quoteSchema.index({ job: 1, mechanic: 1, status: 1 });
quoteSchema.index({ mechanic: 1, createdAt: -1 });
quoteSchema.index({ company: 1, createdAt: -1 });
quoteSchema.index({ status: 1, expiresAt: 1 });

export const Quote = model("Quote", quoteSchema);
