import { sendResponse } from "../../utils/sendResponse.js";
import { findUserById, updateOwnProfile } from "./user.service.js";

export const getMe = async (req, res) => {
  const user = await findUserById(req.user._id);
  return sendResponse(res, {
    message: "User profile fetched",
    data: user,
  });
};

export const updateMe = async (req, res) => {
  const user = await findUserById(req.user._id);
  const updated = await updateOwnProfile(user, req.body);

  return sendResponse(res, {
    message: "Profile updated",
    data: updated,
  });
};
