import AppError from "../../utils/AppError.js";
import { Vehicle } from "./vehicle.model.js";

const normalizeRegistration = (value) =>
  `${value || ""}`.trim().toUpperCase();

const filterObject = (payload, allowedFields) =>
  Object.fromEntries(
    Object.entries(payload).filter(([key, value]) => {
      if (!allowedFields.includes(key)) return false;
      return value !== undefined;
    })
  );

export const createVehicle = async (fleetUser, payload) => {
  const registration = normalizeRegistration(payload.registration);
  if (!registration) {
    throw new AppError("registration is required", 400);
  }

  const existing = await Vehicle.findOne({
    fleet: fleetUser._id,
    registration,
  });
  if (existing) {
    throw new AppError("Vehicle registration already exists", 409);
  }

  return Vehicle.create({
    fleet: fleetUser._id,
    registration,
    type: payload.type,
    make: payload.make,
    model: payload.model,
    year: payload.year,
    vin: payload.vin,
  });
};

export const listVehicles = async (fleetUser, query) => {
  const includeInactive = `${query.includeInactive}` === "true";
  const filter = { fleet: fleetUser._id };
  if (!includeInactive) filter.isActive = true;

  return Vehicle.find(filter).sort({ createdAt: -1 }).lean();
};

export const updateVehicle = async (fleetUser, vehicleId, payload) => {
  const vehicle = await Vehicle.findOne({
    _id: vehicleId,
    fleet: fleetUser._id,
  });
  if (!vehicle) throw new AppError("Vehicle not found", 404);

  const patch = filterObject(payload, [
    "registration",
    "type",
    "make",
    "model",
    "year",
    "vin",
    "isActive",
  ]);

  if (patch.registration !== undefined) {
    patch.registration = normalizeRegistration(patch.registration);
    if (!patch.registration) {
      throw new AppError("registration cannot be empty", 400);
    }

    const duplicate = await Vehicle.findOne({
      _id: { $ne: vehicle._id },
      fleet: fleetUser._id,
      registration: patch.registration,
    });
    if (duplicate) {
      throw new AppError("Vehicle registration already exists", 409);
    }
  }

  Object.assign(vehicle, patch);
  await vehicle.save();
  return vehicle;
};

export const deleteVehicle = async (fleetUser, vehicleId) => {
  const vehicle = await Vehicle.findOne({
    _id: vehicleId,
    fleet: fleetUser._id,
  });
  if (!vehicle) throw new AppError("Vehicle not found", 404);

  vehicle.isActive = false;
  await vehicle.save({ validateBeforeSave: false });

  return {
    _id: vehicle._id,
    registration: vehicle.registration,
    isActive: vehicle.isActive,
  };
};
