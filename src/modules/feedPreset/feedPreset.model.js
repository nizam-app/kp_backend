import mongoose from "mongoose";

const { Schema, model } = mongoose;

/** Saved marketplace feed filters per user (mechanic / fleet / company). */
const feedPresetSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, required: true, trim: true },
    /** Query params shaped like listJobs feed filters, e.g. feed, radiusMiles, minPayout, issueType, postcode, urgency */
    filters: { type: Schema.Types.Mixed, default: {} },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true }
);

feedPresetSchema.index({ user: 1, name: 1 }, { unique: true });

export const FeedPreset = model("FeedPreset", feedPresetSchema);
