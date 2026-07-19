import mongoose from "mongoose";

const { Schema, model } = mongoose;

const disputeEvidenceSchema = new Schema(
  {
    dispute: { type: Schema.Types.ObjectId, ref: "Dispute", required: true, index: true },
    uploader: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    uploaderRole: { type: String, trim: true, required: true },
    representedParty: {
      type: String,
      enum: ["CLAIMANT", "RESPONDENT", "ADMIN"],
      required: true,
    },
    originalName: { type: String, required: true, trim: true },
    storageKey: { type: String, required: true, trim: true },
    mimeType: { type: String, required: true, trim: true },
    size: { type: Number, required: true, min: 1 },
    sha256: { type: String, required: true, trim: true },
    source: {
      type: String,
      enum: ["UPLOAD", "JOB_ATTACHMENT", "CHAT_ATTACHMENT", "STRIPE"],
      default: "UPLOAD",
    },
    scanStatus: {
      type: String,
      enum: ["PENDING", "CLEAN", "REJECTED", "UNAVAILABLE"],
      default: "PENDING",
      index: true,
    },
    sealedAt: { type: Date, default: Date.now },
    description: { type: String, trim: true },
  },
  { timestamps: true, updateTimestamp: false }
);

disputeEvidenceSchema.index({ dispute: 1, createdAt: 1 });
disputeEvidenceSchema.index({ sha256: 1, dispute: 1 });

export const DisputeEvidence = model("DisputeEvidence", disputeEvidenceSchema);
