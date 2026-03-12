import mongoose from "mongoose";

const { Schema, model } = mongoose;

const supportTicketSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    subject: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    category: { type: String, trim: true, default: "GENERAL" },
    status: {
      type: String,
      enum: ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"],
      default: "OPEN",
      index: true,
    },
    assignedTo: { type: Schema.Types.ObjectId, ref: "User" },
    resolution: { type: String, trim: true },
    resolvedAt: Date,
  },
  { timestamps: true }
);

supportTicketSchema.index({ user: 1, createdAt: -1 });

export const SupportTicket = model("SupportTicket", supportTicketSchema);

