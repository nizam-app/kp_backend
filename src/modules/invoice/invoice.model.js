import mongoose from "mongoose";

const { Schema, model } = mongoose;

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
  },
  { timestamps: true }
);

invoiceSchema.index({ fleet: 1, createdAt: -1 });
invoiceSchema.index({ mechanic: 1, createdAt: -1 });

export const Invoice = model("Invoice", invoiceSchema);

