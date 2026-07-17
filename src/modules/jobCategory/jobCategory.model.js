import mongoose from "mongoose";
import { issueTypeValues } from "../../constants/domain.js";

const { Schema, model } = mongoose;

const jobCategorySchema = new Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
      uppercase: true,
      immutable: true,
    },
    label: { type: String, required: true, trim: true, maxlength: 120 },
    issueType: { type: String, required: true, enum: issueTypeValues, index: true },
    icon: { type: String, trim: true, maxlength: 16, default: "🔧" },
    isActive: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, min: 0, default: 0, index: true },
    aliases: [{ type: String, trim: true, maxlength: 120 }],
  },
  { timestamps: true }
);

jobCategorySchema.index({ isActive: 1, sortOrder: 1, label: 1 });

export const JobCategory = model("JobCategory", jobCategorySchema);
