import crypto from "crypto";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import {
  MECHANIC_AVAILABILITY,
  MECHANIC_BUSINESS_TYPE,
  MECHANIC_VERIFICATION_STATUS,
  USER_STATUS,
  mechanicAvailabilityValues,
  mechanicBusinessTypeValues,
  roleValues,
  userStatusValues,
  verificationStatusValues,
} from "../../constants/domain.js";

const { Schema, model } = mongoose;

const fleetProfileSchema = new Schema(
  {
    profilePhotoUrl: { type: String, trim: true },
    companyName: { type: String, trim: true },
    contactName: { type: String, trim: true },
    contactRole: { type: String, trim: true },
    phone: { type: String, trim: true },
    regNumber: { type: String, trim: true },
    vatNumber: { type: String, trim: true },
    fleetSize: { type: String, trim: true },
    defaultAddress: { type: String, trim: true },
    billingAddress: { type: String, trim: true },
    profileCompleted: { type: Boolean, default: false },
    stripeCustomerId: { type: String, trim: true },
  },
  { _id: false }
);

const mechanicLastKnownLocationSchema = new Schema(
  {
    type: {
      type: String,
      enum: ["Point"],
    },
    coordinates: {
      type: [Number],
      validate: {
        validator: (value) =>
          !value ||
          (Array.isArray(value) && (value.length === 0 || value.length === 2)),
        message: "Location must be [lng, lat]",
      },
    },
    updatedAt: Date,
  },
  { _id: false }
);

const mechanicProfileSchema = new Schema(
  {
    profilePhotoUrl: { type: String, trim: true },
    businessType: {
      type: String,
      enum: mechanicBusinessTypeValues,
      default: MECHANIC_BUSINESS_TYPE.SOLE_TRADER,
    },
    displayName: { type: String, trim: true },
    businessName: { type: String, trim: true },
    phone: { type: String, trim: true },
    baseLocationText: { type: String, trim: true },
    basePostcode: { type: String, trim: true },
    hourlyRate: { type: Number, min: 0 },
    emergencyRate: { type: Number, min: 0 },
    emergencySurcharge: { type: Number, min: 0 },
    callOutFee: { type: Number, min: 0 },
    rateCurrency: { type: String, trim: true, default: "ZAR" },
    serviceRadiusMiles: { type: Number, min: 1, default: 25 },
    skills: {
      type: [String],
      default: [],
      enum: ["TYRES", "BATTERY", "ENGINE", "BRAKES", "ELECTRICAL", "OTHER"],
    },
    availability: {
      type: String,
      enum: mechanicAvailabilityValues,
      default: MECHANIC_AVAILABILITY.OFFLINE,
    },
    profileCompleted: { type: Boolean, default: false },
    verification: {
      status: {
        type: String,
        enum: verificationStatusValues,
        default: MECHANIC_VERIFICATION_STATUS.NOT_SUBMITTED,
      },
      submittedAt: Date,
      reviewedAt: Date,
      reviewNotes: { type: String, trim: true },
    },
    lastKnownLocation: {
      type: mechanicLastKnownLocationSchema,
      default: undefined,
    },
    rating: {
      average: { type: Number, min: 0, max: 5, default: 0 },
      count: { type: Number, min: 0, default: 0 },
    },
    stats: {
      jobsDone: { type: Number, min: 0, default: 0 },
      responseMinutesAvg: { type: Number, min: 0, default: 0 },
    },
  },
  { _id: false }
);

const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    password: {
      type: String,
      required: true,
      minlength: 8,
      select: false,
    },
    role: {
      type: String,
      enum: roleValues,
      required: true,
    },
    status: {
      type: String,
      enum: userStatusValues,
      default: USER_STATUS.ACTIVE,
    },
    preferences: {
      pushEnabled: { type: Boolean, default: true },
      alertRadiusMiles: { type: Number, min: 1, default: 25 },
      notifications: {
        newBreakdownJobs: { type: Boolean, default: true },
        jobAcceptedDeclined: { type: Boolean, default: true },
        paymentReceived: { type: Boolean, default: true },
        systemAlerts: { type: Boolean, default: true },
      },
    },
    termsAcceptance: {
      acceptedAt: Date,
      version: { type: String, trim: true },
      source: { type: String, trim: true },
    },
    fleetProfile: fleetProfileSchema,
    mechanicProfile: mechanicProfileSchema,
    passwordChangedAt: Date,
    passwordResetToken: {
      type: String,
      select: false,
    },
    passwordResetExpires: {
      type: Date,
      select: false,
    },
    refreshTokenHash: {
      type: String,
      select: false,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret) => {
        delete ret.password;
        delete ret.passwordResetToken;
        delete ret.passwordResetExpires;
        return ret;
      },
    },
  }
);

userSchema.index({ "mechanicProfile.lastKnownLocation": "2dsphere" });
userSchema.index({ role: 1, status: 1 });
userSchema.index({ "mechanicProfile.verification.status": 1, status: 1 });

userSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  this.password = await bcrypt.hash(this.password, 12);
  if (!this.isNew) this.passwordChangedAt = new Date();
});

userSchema.methods.comparePassword = function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.createPasswordResetToken = function () {
  const resetToken = crypto.randomBytes(32).toString("hex");
  this.passwordResetToken = crypto
    .createHash("sha256")
    .update(resetToken)
    .digest("hex");
  this.passwordResetExpires = new Date(Date.now() + 10 * 60 * 1000);
  return resetToken;
};

export const User = model("User", userSchema);
