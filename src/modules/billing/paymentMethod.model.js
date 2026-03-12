import mongoose from "mongoose";

const { Schema, model } = mongoose;

const paymentMethodSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    ownerType: {
      type: String,
      enum: ["FLEET", "MECHANIC"],
      required: true,
      index: true,
    },
    methodType: {
      type: String,
      enum: ["CARD", "BANK_ACCOUNT"],
      required: true,
      index: true,
    },
    provider: { type: String, trim: true, default: "MANUAL" },
    providerMethodId: { type: String, trim: true, required: true },
    card: {
      brand: { type: String, trim: true },
      last4: { type: String, trim: true },
      expMonth: Number,
      expYear: Number,
    },
    bank: {
      bankName: { type: String, trim: true },
      accountMasked: { type: String, trim: true },
      sortCodeMasked: { type: String, trim: true },
    },
    billingAddress: { type: String, trim: true },
    isDefault: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

paymentMethodSchema.index({ user: 1, isDefault: 1, isActive: 1 });
paymentMethodSchema.index({ provider: 1, providerMethodId: 1 }, { unique: true });

export const PaymentMethod = model("PaymentMethod", paymentMethodSchema);

