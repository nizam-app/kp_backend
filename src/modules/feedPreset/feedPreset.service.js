import AppError from "../../utils/AppError.js";
import { FeedPreset } from "./feedPreset.model.js";
import { ROLES } from "../../constants/domain.js";

const allowedRoles = [
  ROLES.MECHANIC,
  ROLES.FLEET,
  ROLES.COMPANY,
  ROLES.MECHANIC_EMPLOYEE,
];

const ensureFeedRole = (user) => {
  if (!allowedRoles.includes(user.role)) {
    throw new AppError("Feed presets are not available for this role", 403);
  }
};

export const listFeedPresets = async (user) => {
  ensureFeedRole(user);
  const items = await FeedPreset.find({ user: user._id }).sort({ updatedAt: -1 }).lean();
  return { items };
};

export const createFeedPreset = async (user, payload = {}) => {
  ensureFeedRole(user);
  const name = `${payload.name || ""}`.trim();
  if (!name) throw new AppError("name is required", 400);

  const filters =
    payload.filters && typeof payload.filters === "object" ? payload.filters : {};

  if (payload.isDefault) {
    await FeedPreset.updateMany({ user: user._id }, { $set: { isDefault: false } });
  }

  try {
    const preset = await FeedPreset.create({
      user: user._id,
      name,
      filters,
      isDefault: Boolean(payload.isDefault),
    });
    return preset.toObject();
  } catch (e) {
    if (e?.code === 11000) {
      throw new AppError("A preset with this name already exists", 409);
    }
    throw e;
  }
};

export const updateFeedPreset = async (user, presetId, payload = {}) => {
  ensureFeedRole(user);
  const preset = await FeedPreset.findOne({ _id: presetId, user: user._id });
  if (!preset) throw new AppError("Preset not found", 404);

  if (payload.name !== undefined) {
    const name = `${payload.name || ""}`.trim();
    if (!name) throw new AppError("name cannot be empty", 400);
    preset.name = name;
  }
  if (payload.filters !== undefined) {
    if (payload.filters !== null && typeof payload.filters !== "object") {
      throw new AppError("filters must be an object", 400);
    }
    preset.filters = payload.filters || {};
  }
  if (payload.isDefault !== undefined) {
    if (payload.isDefault) {
      await FeedPreset.updateMany(
        { user: user._id, _id: { $ne: preset._id } },
        { $set: { isDefault: false } }
      );
    }
    preset.isDefault = Boolean(payload.isDefault);
  }

  try {
    await preset.save();
  } catch (e) {
    if (e?.code === 11000) {
      throw new AppError("A preset with this name already exists", 409);
    }
    throw e;
  }
  return preset.toObject();
};

export const deleteFeedPreset = async (user, presetId) => {
  ensureFeedRole(user);
  const result = await FeedPreset.deleteOne({ _id: presetId, user: user._id });
  if (!result.deletedCount) throw new AppError("Preset not found", 404);
  return { deleted: true };
};
