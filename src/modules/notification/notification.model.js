import mongoose from "mongoose";

const { Schema, model } = mongoose;

const notificationSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: { type: String, required: true, trim: true },
    eventKey: { type: String, trim: true, index: true },
    dedupeKey: { type: String, trim: true },
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true, trim: true },
    data: { type: Schema.Types.Mixed },
    channels: {
      inApp: { type: Boolean, default: true },
      push: { type: Boolean, default: true },
      email: { type: Boolean, default: false },
    },
    delivery: {
      emailStatus: {
        type: String,
        enum: ["NOT_REQUESTED", "SENT", "SKIPPED", "FAILED"],
        default: "NOT_REQUESTED",
      },
      emailError: { type: String, trim: true },
      emailAttemptedAt: Date,
    },
    isRead: { type: Boolean, default: false, index: true },
    readAt: Date,
  },
  { timestamps: true }
);

notificationSchema.index({ user: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ eventKey: 1, createdAt: -1 });
notificationSchema.index(
  { user: 1, eventKey: 1, dedupeKey: 1 },
  { unique: true, sparse: true }
);

export const Notification = model("Notification", notificationSchema);

