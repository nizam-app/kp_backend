import mongoose from "mongoose";

const { Schema, model } = mongoose;

const disputeTaskSchema = new Schema(
  {
    dispute: { type: Schema.Types.ObjectId, ref: "Dispute", required: true, index: true },
    type: { type: String, required: true, trim: true },
    owner: { type: Schema.Types.ObjectId, ref: "User", index: true },
    ownerType: {
      type: String,
      enum: ["CLAIMANT", "RESPONDENT", "ADMIN", "STRIPE"],
      required: true,
    },
    status: {
      type: String,
      enum: ["OPEN", "COMPLETED", "CANCELLED", "OVERDUE"],
      default: "OPEN",
      index: true,
    },
    dueAt: { type: Date, required: true, index: true },
    completedAt: Date,
    reminderCount: { type: Number, min: 0, default: 0 },
    lastReminderAt: Date,
  },
  { timestamps: true }
);

disputeTaskSchema.index({ dispute: 1, status: 1, dueAt: 1 });

export const DisputeTask = model("DisputeTask", disputeTaskSchema);
