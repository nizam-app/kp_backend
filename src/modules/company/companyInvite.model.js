import mongoose from "mongoose";

const { Schema, model } = mongoose;

const companyInviteSchema = new Schema(
  {
    company: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    email: { type: String, required: true, trim: true, lowercase: true, index: true },
    invitedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    status: {
      type: String,
      enum: ["PENDING", "ACCEPTED", "CANCELLED", "EXPIRED"],
      default: "PENDING",
    },
    token: { type: String, required: true, unique: true, index: true },
    expiresAt: { type: Date, required: true, index: true },
    acceptedAt: Date,
    cancelledAt: Date,
  },
  { timestamps: true }
);

companyInviteSchema.index({ company: 1, status: 1, createdAt: -1 });

export const CompanyInvite = model("CompanyInvite", companyInviteSchema);
