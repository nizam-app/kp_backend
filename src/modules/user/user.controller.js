import { sendResponse } from "../../utils/sendResponse.js";
import {
  acceptUserTerms,
  deleteOwnAccount,
  getOwnProfile,
  updateMechanicAvailability,
  updateOwnProfile,
  updateUserPreferences,
} from "./user.service.js";
import {
  acceptCompanyInviteAsMechanic,
  declineCompanyInviteAsMechanic,
  listPendingInvitesForMechanic,
} from "../company/company.service.js";

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

export const deleteMeController = async (req, res) => {
  const result = await deleteOwnAccount(req.user, req.body);

  return sendResponse(res, {
    message: "Account deleted",
    data: result,
  });
};

export const listMyCompanyInvitesController = async (req, res) => {
  const result = await listPendingInvitesForMechanic(req.user);
  return sendResponse(res, {
    message: "Pending company invites",
    data: result,
  });
};

export const acceptMyCompanyInviteController = async (req, res) => {
  const result = await acceptCompanyInviteAsMechanic(req.params.inviteId, req.user);
  return sendResponse(res, {
    message: "Invite accepted",
    data: result,
  });
};

export const declineMyCompanyInviteController = async (req, res) => {
  const result = await declineCompanyInviteAsMechanic(req.params.inviteId, req.user);
  return sendResponse(res, {
    message: "Invite declined",
    data: result,
  });
};
