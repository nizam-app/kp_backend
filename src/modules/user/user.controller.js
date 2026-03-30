import { sendResponse } from "../../utils/sendResponse.js";
import {
  acceptUserTerms,
  getOwnProfile,
  updateMechanicAvailability,
  updateOwnProfile,
  updateUserPreferences,
} from "./user.service.js";

export const getMe = async (req, res) => {
  const user = await getOwnProfile(req.user._id);
  return sendResponse(res, {
    message: "User profile fetched",
    data: user,
  });
};

export const updateMe = async (req, res) => {
  const updated = await updateOwnProfile(req.user, req.body);

  return sendResponse(res, {
    message: "Profile updated",
    data: updated,
  });
};

export const updatePreferencesController = async (req, res) => {
  const updated = await updateUserPreferences(req.user, req.body);

  return sendResponse(res, {
    message: "Preferences updated",
    data: updated,
  });
};

export const acceptTermsController = async (req, res) => {
  const updated = await acceptUserTerms(req.user, req.body);

  return sendResponse(res, {
    message: "Terms accepted",
    data: updated,
  });
};

export const updateMechanicAvailabilityController = async (req, res) => {
  const updated = await updateMechanicAvailability(req.user, req.body);

  return sendResponse(res, {
    message: "Availability updated",
    data: updated,
  });
};
