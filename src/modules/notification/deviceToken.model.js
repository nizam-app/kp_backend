import mongoose from "mongoose";

const { Schema, model } = mongoose;

const deviceTokenSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    token: { type: String, required: true, trim: true, unique: true },
    platform: {
      type: String,
      enum: ["ios", "android", "web"],
      required: true,
    },
    appVersion: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

deviceTokenSchema.index({ user: 1, isActive: 1, updatedAt: -1 });

export const DeviceToken = model("DeviceToken", deviceTokenSchema);

