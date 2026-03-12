import mongoose from "mongoose";
import { jobStatusValues } from "../../constants/domain.js";

const { Schema, model } = mongoose;

const jobEventSchema = new Schema(
  {
    job: { type: Schema.Types.ObjectId, ref: "Job", required: true, index: true },
    actor: { type: Schema.Types.ObjectId, ref: "User" },
    type: { type: String, required: true, trim: true },
    fromStatus: { type: String, enum: jobStatusValues },
    toStatus: { type: String, enum: jobStatusValues },
    note: { type: String, trim: true },
    visibility: {
      type: String,
      enum: ["PUBLIC", "INTERNAL"],
      default: "PUBLIC",
    },
    location: {
      type: {
        type: String,
        enum: ["Point"],
      },
      coordinates: {
        type: [Number],
        validate: {
          validator: (value) =>
            !value || (Array.isArray(value) && value.length === 2),
          message: "Event location must be [lng, lat]",
        },
      },
    },
    payload: { type: Schema.Types.Mixed },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { versionKey: false }
);

jobEventSchema.index({ job: 1, createdAt: -1 });
jobEventSchema.index({ actor: 1, createdAt: -1 });

export const JobEvent = model("JobEvent", jobEventSchema);
