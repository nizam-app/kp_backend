import mongoose from "mongoose";

const { Schema, model } = mongoose;

const reviewSchema = new Schema(
  {
    fleet: { type: Schema.Types.ObjectId, ref: "User", index: true },
    mechanic: { type: Schema.Types.ObjectId, ref: "User", index: true },
    job: { type: Schema.Types.ObjectId, ref: "Job", index: true },
    customerName: { type: String, required: true, trim: true },
    companyName: { type: String, trim: true },
    serviceLabel: { type: String, trim: true },
    mechanicName: { type: String, trim: true },
    rating: { type: Number, min: 1, max: 5, required: true, index: true },
    comment: { type: String, trim: true },
    status: {
      type: String,
      enum: ["PUBLISHED", "FLAGGED", "HIDDEN"],
      default: "PUBLISHED",
      index: true,
    },
  },
  { timestamps: true }
);

reviewSchema.index({ createdAt: -1 });
reviewSchema.index({ fleet: 1, createdAt: -1 });
reviewSchema.index({ mechanic: 1, createdAt: -1 });
reviewSchema.index({ job: 1 }, { unique: true, sparse: true });

export const Review = model("Review", reviewSchema);
