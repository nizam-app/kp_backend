import mongoose from "mongoose";

const { Schema, model } = mongoose;

const jobLocationPingSchema = new Schema(
  {
    job: { type: Schema.Types.ObjectId, ref: "Job", required: true, index: true },
    mechanic: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    point: {
      type: {
        type: String,
        enum: ["Point"],
        default: "Point",
      },
      coordinates: {
        type: [Number],
        required: true,
        validate: {
          validator: (value) => Array.isArray(value) && value.length === 2,
          message: "Point must be [lng, lat]",
        },
      },
    },
    heading: Number,
    speed: Number,
    accuracy: Number,
    pingedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false, versionKey: false }
);

jobLocationPingSchema.index({ point: "2dsphere" });
jobLocationPingSchema.index({ job: 1, pingedAt: -1 });

export const JobLocationPing = model("JobLocationPing", jobLocationPingSchema);

