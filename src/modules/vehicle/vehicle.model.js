import mongoose from "mongoose";

const { Schema, model } = mongoose;

const vehicleSchema = new Schema(
  {
    fleet: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    registration: { type: String, required: true, trim: true, uppercase: true },
    type: { type: String, trim: true },
    make: { type: String, trim: true },
    model: { type: String, trim: true },
    year: { type: Number, min: 1950, max: 2100 },
    vin: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

vehicleSchema.index({ fleet: 1, isActive: 1, createdAt: -1 });
vehicleSchema.index({ fleet: 1, registration: 1 }, { unique: true });

export const Vehicle = model("Vehicle", vehicleSchema);

