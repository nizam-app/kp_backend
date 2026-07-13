import mongoose from "mongoose";

const { Schema, model } = mongoose;

const SUPPORT_CATEGORIES = ["GENERAL", "BILLING", "JOB_ISSUE", "ACCOUNT", "TECHNICAL"];
const SUPPORT_STATUSES = ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"];

const supportReplySchema = new Schema(
  {
    sender: { type: Schema.Types.ObjectId, ref: "User", required: true },
    role: { type: String, trim: true, required: true },
    message: { type: String, required: true, trim: true },
    internal: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const supportTicketSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    ticketRef: { type: String, trim: true, index: true },
    subject: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    category: {
      type: String,
      enum: SUPPORT_CATEGORIES,
      default: "GENERAL",
      index: true,
    },
    status: {
      type: String,
      enum: SUPPORT_STATUSES,
      default: "OPEN",
      index: true,
    },
    job: { type: Schema.Types.ObjectId, ref: "Job", index: true },
    jobCode: { type: String, trim: true },
    assignedTo: { type: Schema.Types.ObjectId, ref: "User" },
    resolution: { type: String, trim: true },
    resolvedAt: Date,
    replies: {
      type: [supportReplySchema],
      default: [],
    },
  },
  { timestamps: true }
);

supportTicketSchema.index({ user: 1, createdAt: -1 });
supportTicketSchema.index({ status: 1, createdAt: -1 });

export const SUPPORT_TICKET_CATEGORIES = SUPPORT_CATEGORIES;
export const SUPPORT_TICKET_STATUSES = SUPPORT_STATUSES;
export const SupportTicket = model("SupportTicket", supportTicketSchema);
