import mongoose from "mongoose";

const { Schema, model } = mongoose;

const disputeEventSchema = new Schema(
  {
    dispute: { type: Schema.Types.ObjectId, ref: "Dispute", required: true, index: true },
    actor: { type: Schema.Types.ObjectId, ref: "User", index: true },
    actorRole: { type: String, trim: true },
    source: {
      type: String,
      enum: ["USER", "ADMIN", "SYSTEM", "STRIPE"],
      required: true,
    },
    type: { type: String, required: true, trim: true, index: true },
    fromStatus: { type: String, trim: true },
    toStatus: { type: String, trim: true },
    reason: { type: String, trim: true },
    correlationId: { type: String, trim: true, index: true },
    payload: { type: Schema.Types.Mixed },
  },
  { timestamps: true, updateTimestamp: false }
);

disputeEventSchema.index({ dispute: 1, createdAt: 1 });
disputeEventSchema.index(
  { dispute: 1, correlationId: 1 },
  {
    unique: true,
    partialFilterExpression: { correlationId: { $type: "string" } },
    name: "uniq_dispute_event_correlation",
  }
);

export const DisputeEvent = model("DisputeEvent", disputeEventSchema);
