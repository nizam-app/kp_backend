import { sendResponse } from "../../utils/sendResponse.js";
import {
  createFeedPreset,
  deleteFeedPreset,
  listFeedPresets,
  updateFeedPreset,
} from "./feedPreset.service.js";

export const listFeedPresetsController = async (req, res) => {
  const data = await listFeedPresets(req.user);
  return sendResponse(res, { message: "Feed presets fetched", data });
};

export const createFeedPresetController = async (req, res) => {
  const data = await createFeedPreset(req.user, req.body);
  return sendResponse(res, { statusCode: 201, message: "Feed preset created", data });
};

export const updateFeedPresetController = async (req, res) => {
  const data = await updateFeedPreset(req.user, req.params.presetId, req.body);
  return sendResponse(res, { message: "Feed preset updated", data });
};

export const deleteFeedPresetController = async (req, res) => {
  const data = await deleteFeedPreset(req.user, req.params.presetId);
  return sendResponse(res, { message: "Feed preset deleted", data });
};
