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
      "displayName",
      "businessName",
      "phone",
      "baseLocationText",
      "hourlyRate",
      "emergencyRate",
      "callOutFee",
      "serviceRadiusMiles",
      "skills",
      "availability",
      "lastKnownLocation",
      "profileCompleted",
    ]);
    user.mechanicProfile = {
      ...(user.mechanicProfile || {}),
      ...patch,
    };
  }

  await user.save();
  return user;
};
