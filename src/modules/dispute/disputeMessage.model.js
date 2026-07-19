import mongoose from "mongoose";

const { Schema, model } = mongoose;

const disputeMessageSchema = new Schema(
  {
    dispute: { type: Schema.Types.ObjectId, ref: "Dispute", required: true, index: true },
    sender: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    senderRole: { type: String, trim: true, required: true },
    visibility: {
      type: String,
      enum: ["PARTIES", "INTERNAL"],
      default: "PARTIES",
      index: true,
    },
    body: { type: String, required: true, trim: true, maxlength: 5000 },
    readBy: [{ type: Schema.Types.ObjectId, ref: "User" }],
  },
  { timestamps: true, updateTimestamp: false }
);

disputeMessageSchema.index({ dispute: 1, createdAt: 1 });

export const DisputeMessage = model("DisputeMessage", disputeMessageSchema);
