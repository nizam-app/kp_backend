import mongoose from "mongoose";

const { Schema, model } = mongoose;

const promotionSchema = new Schema(
  {
    code: { type: String, required: true, trim: true, uppercase: true, unique: true, index: true },
    discountType: {
      type: String,
      enum: ["PERCENTAGE", "FIXED"],
      default: "PERCENTAGE",
    },
    discountValue: { type: Number, required: true, min: 0 },
    minAmount: { type: Number, min: 0, default: 0 },
    currency: { type: String, trim: true, default: "GBP" },
    usageCount: { type: Number, min: 0, default: 0 },
    usageLimit: { type: Number, min: 1, default: 100 },
    status: {
      type: String,
      enum: ["ACTIVE", "INACTIVE", "EXPIRED"],
      default: "ACTIVE",
      index: true,
    },
    expiresAt: Date,
  },
  { timestamps: true }
);

export const Promotion = model("Promotion", promotionSchema);
