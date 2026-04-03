import mongoose from "mongoose";

const { Schema, model } = mongoose;

const serviceCatalogSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, index: true },
    category: { type: String, required: true, trim: true, index: true },
    description: { type: String, trim: true },
    basePrice: { type: Number, min: 0, default: 0 },
    currency: { type: String, trim: true, default: "GBP" },
    durationLabel: { type: String, trim: true },
    isActive: { type: Boolean, default: true, index: true },
    bookingsCount: { type: Number, min: 0, default: 0 },
  },
  { timestamps: true }
);

serviceCatalogSchema.index({ category: 1, isActive: 1 });

export const ServiceCatalog = model("ServiceCatalog", serviceCatalogSchema);
