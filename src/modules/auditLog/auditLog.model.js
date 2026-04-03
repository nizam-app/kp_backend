import mongoose from "mongoose";

const { Schema, model } = mongoose;

const auditLogSchema = new Schema(
  {
    userLabel: { type: String, required: true, trim: true },
    action: { type: String, required: true, trim: true },
    target: { type: String, trim: true },
    category: { type: String, trim: true, index: true },
    ipAddress: { type: String, trim: true },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { versionKey: false }
);

auditLogSchema.index({ category: 1, createdAt: -1 });

export const AuditLog = model("AuditLog", auditLogSchema);
