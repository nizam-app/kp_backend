import mongoose from "mongoose";

const { Schema, model } = mongoose;

/** Singleton platform commercial policy (not per-admin preferences). */
const platformSettingsSchema = new Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: "default",
      trim: true,
    },
    /** Platform commission as a whole percent, e.g. 12 => 12%. */
    platformFeePercent: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
      default: 12,
    },
    /**
     * Standard UK VAT rate as a fraction, e.g. 0.2 => 20%.
     * Still only applied when the assigned supplier is VAT-registered.
     */
    standardVatRate: {
      type: Number,
      required: true,
      min: 0,
      max: 1,
      default: 0.2,
    },
    /**
     * When true, MECHANIC/COMPANY must complete profile + Stripe Connect
     * before submitting or amending quotes. Defaults false (legacy behaviour).
     */
    enforceProviderQuoteReadiness: {
      type: Boolean,
      default: false,
    },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

export const PlatformSettings = model("PlatformSettings", platformSettingsSchema);
