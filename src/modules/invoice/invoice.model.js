import mongoose from "mongoose";

const { Schema, model } = mongoose;

const invoiceLineItemSchema = new Schema(
  {
    description: { type: String, required: true, trim: true },
    quantity: { type: Number, default: 1, min: 0 },
    unitAmount: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const invoiceSchema = new Schema(
  {
    invoiceNo: { type: String, required: true, unique: true, index: true },
    job: { type: Schema.Types.ObjectId, ref: "Job", required: true, index: true },
    fleet: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    mechanic: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    subtotal: { type: Number, required: true, min: 0 },
    vatAmount: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, required: true, min: 0 },
    currency: { type: String, trim: true, default: "GBP" },
    status: {
      type: String,
      enum: ["DRAFT", "ISSUED", "PAID", "VOID"],
      default: "ISSUED",
      index: true,
    },
    issuedAt: { type: Date, default: Date.now },
    paidAt: Date,
    pdfUrl: { type: String, trim: true },
    lineItems: {
      type: [invoiceLineItemSchema],
      default: [],
    },
    billedToSnapshot: {
      companyName: { type: String, trim: true },
      vatNumber: { type: String, trim: true },
      address: { type: String, trim: true },
    },
    mechanicSnapshot: {
      displayName: { type: String, trim: true },
      businessName: { type: String, trim: true },
      rating: { type: Number, min: 0, max: 5 },
    },
  },
  { timestamps: true }
);

invoiceSchema.index({ fleet: 1, createdAt: -1 });
invoiceSchema.index({ mechanic: 1, createdAt: -1 });

export const Invoice = model("Invoice", invoiceSchema);
