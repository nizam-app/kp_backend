import AppError from "../../utils/AppError.js";
import { User } from "./user.model.js";

const filterObject = (payload, allowedFields) =>
  Object.fromEntries(
    Object.entries(payload).filter(([key, value]) => {
      if (!allowedFields.includes(key)) return false;
      return value !== undefined;
    })
  );

export const findUserById = async (userId) => {
  const user = await User.findById(userId);
  if (!user) throw new AppError("User not found", 404);
  return user;
};

export const updateOwnProfile = async (user, payload) => {
  if (user.role === "FLEET") {
    const patch = filterObject(payload, [
      "companyName",
      "contactName",
      "contactRole",
      "phone",
      "regNumber",
      "vatNumber",
      "fleetSize",
      "defaultAddress",
      "billingAddress",
      "profileCompleted",
    ]);
    user.fleetProfile = {
      ...(user.fleetProfile || {}),
      ...patch,
    };
  }

  if (user.role === "MECHANIC") {
    const patch = filterObject(payload, [
      "businessType",
      "displayName",
      "businessName",
      "phone",
      "baseLocationText",
      "basePostcode",
      "hourlyRate",
      "emergencyRate",
      "emergencySurcharge",
      "callOutFee",
      "callOutCharge",
      "rateCurrency",
      "serviceRadiusMiles",
      "coverageRadius",
      "skills",
      "availability",
      "lastKnownLocation",
      "profileCompleted",
      "profilePhotoUrl",
    ]);

    const normalizedPatch = {
      ...patch,
      callOutFee: patch.callOutCharge ?? patch.callOutFee,
      serviceRadiusMiles: patch.coverageRadius ?? patch.serviceRadiusMiles,
    };

    delete normalizedPatch.callOutCharge;
    delete normalizedPatch.coverageRadius;

    user.mechanicProfile = {
      ...(user.mechanicProfile || {}),
      ...normalizedPatch,
    };
  }

  await user.save();
  return user;
};
