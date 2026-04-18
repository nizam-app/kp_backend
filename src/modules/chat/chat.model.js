import mongoose from "mongoose";

const { Schema, model } = mongoose;

const readReceiptSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    readAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const chatMessageSchema = new Schema(
  {
    job: { type: Schema.Types.ObjectId, ref: "Job", required: true, index: true },
    sender: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    text: { type: String, required: true, trim: true },
    attachments: {
      type: [String],
      default: [],
    },
    readBy: {
      type: [readReceiptSchema],
      default: [],
    },
  },
  { timestamps: true }
);

chatMessageSchema.index({ job: 1, createdAt: -1 });
chatMessageSchema.index({ sender: 1, createdAt: -1 });

export const ChatMessage = model("ChatMessage", chatMessageSchema);
