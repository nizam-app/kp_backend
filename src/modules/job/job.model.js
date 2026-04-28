import mongoose from "mongoose";
import {
  ISSUE_TYPES,
  JOB_STATUS,
  JOB_URGENCY,
  issueTypeValues,
  jobStatusValues,
  urgencyValues,
} from "../../constants/domain.js";

const { Schema, model } = mongoose;

const locationSchema = new Schema(
  {
    type: {
      type: String,
      enum: ["Point"],
      default: "Point",
    },
    coordinates: {
      type: [Number],
      validate: {
        validator: (value) =>
          Array.isArray(value) && value.length === 2 && value.every(Number.isFinite),
        message: "Location coordinates must be [lng, lat]",
      },
      required: true,
    },
    address: { type: String, trim: true },
  },
  { _id: false }
);

const vehicleInfoSchema = new Schema(
  {
    vehicleId: { type: String, trim: true },
    registration: { type: String, trim: true },
    type: { type: String, trim: true },
    make: { type: String, trim: true },
    model: { type: String, trim: true },
    trailerMakeModel: { type: String, trim: true },
  },
  { _id: false }
);

const journeyLocationSchema = new Schema(
  {
    point: {
      type: {
        type: String,
        enum: ["Point"],
        default: "Point",
      },
      coordinates: {
        type: [Number],
        validate: {
          validator: (value) =>
            !value || (Array.isArray(value) && value.length === 2),
          message: "Journey point must be [lng, lat]",
        },
      },
    },
    heading: Number,
    speed: Number,
    accuracy: Number,
    updatedAt: Date,
  },
  { _id: false }
);

const availabilityWindowSchema = new Schema(
  {
    from: Date,
    to: Date,
  },
  { _id: false }
);

export const JOB_ATTACHMENT_CATEGORIES = [
  "BEFORE",
  "AFTER",
  "COMPLETION",
  "DIAGNOSTIC",
  "PARTS",
  "INCIDENT",
  "INVOICE",
  "OTHER",
];

export const JOB_ATTACHMENT_FILE_TYPES = ["IMAGE", "PDF", "DOCUMENT", "OTHER"];

const jobAttachmentSchema = new Schema(
  {
    url: { type: String, required: true, trim: true },
    fileType: {
      type: String,
      enum: JOB_ATTACHMENT_FILE_TYPES,
      default: "IMAGE",
    },
    category: {
      type: String,
      enum: JOB_ATTACHMENT_CATEGORIES,
      default: "OTHER",
    },
    mimeType: { type: String, trim: true },
    originalName: { type: String, trim: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

const jobSchema = new Schema(
  {
    jobCode: { type: String, unique: true, index: true },
    fleet: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    assignedCompany: { type: Schema.Types.ObjectId, ref: "User", index: true },
    assignedMechanic: { type: Schema.Types.ObjectId, ref: "User", index: true },
    acceptedQuote: { type: Schema.Types.ObjectId, ref: "Quote" },
    vehicle: vehicleInfoSchema,
    issueType: {
      type: String,
      enum: issueTypeValues,
      default: ISSUE_TYPES.OTHER,
    },
    title: { type: String, trim: true, required: true },
    description: { type: String, trim: true, required: true },
    urgency: {
      type: String,
      enum: urgencyValues,
      default: JOB_URGENCY.MEDIUM,
    },
    mode: {
      type: String,
      enum: ["EMERGENCY", "SCHEDULABLE"],
      default: "EMERGENCY",
    },
    scheduledFor: Date,
    availabilityWindow: availabilityWindowSchema,
    location: { type: locationSchema, required: true },
    photos: { type: [String], default: [] },
    /** Structured proof / documents (images + PDF + office docs) */
    attachments: { type: [jobAttachmentSchema], default: [] },
    status: {
      type: String,
      enum: jobStatusValues,
      default: JOB_STATUS.POSTED,
      index: true,
    },
    quoteCount: { type: Number, default: 0, min: 0 },
    acceptedAmount: { type: Number, min: 0 },
    estimatedPayout: { type: Number, min: 0 },
    finalAmount: { type: Number, min: 0 },
    currency: { type: String, trim: true, default: "GBP" },
    completionSummary: { type: String, trim: true },
    tracking: {
      latestMechanicLocation: journeyLocationSchema,
      etaMinutes: { type: Number, min: 0 },
    },
    companyAssignment: {
      assignedBy: { type: Schema.Types.ObjectId, ref: "User" },
      assignedAt: Date,
      note: { type: String, trim: true },
    },
    cancellation: {
      reason: { type: String, trim: true },
      fee: { type: Number, min: 0, default: 0 },
      feeCurrency: { type: String, trim: true, default: "GBP" },
      cancelledBy: { type: Schema.Types.ObjectId, ref: "User" },
    },
    postedAt: { type: Date, default: Date.now },
    assignedAt: Date,
    completedAt: Date,
    cancelledAt: Date,
  },
  { timestamps: true }
);

jobSchema.index({ "location": "2dsphere" });
jobSchema.index({ mode: 1, scheduledFor: 1 });
jobSchema.index({ mode: 1, "availabilityWindow.from": 1, "availabilityWindow.to": 1 });
jobSchema.index({ fleet: 1, status: 1, createdAt: -1 });
jobSchema.index({ assignedMechanic: 1, status: 1, createdAt: -1 });
jobSchema.index({ assignedCompany: 1, status: 1, createdAt: -1 });

export const Job = model("Job", jobSchema);
