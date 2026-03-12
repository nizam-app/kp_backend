import { sendResponse } from "../../utils/sendResponse.js";
import {
  forgotPassword,
  loginUser,
  logoutUser,
  refreshAccessToken,
  registerUser,
  resetPassword,
} from "./auth.service.js";

export const register = async (req, res) => {
  const result = await registerUser(req.body);
  return sendResponse(res, {
    statusCode: 201,
    message: "Registration successful",
    data: result,
  });
};

export const login = async (req, res) => {
  const result = await loginUser(req.body);
  return sendResponse(res, {
    message: "Login successful",
    data: result,
  });
};

export const forgotPasswordController = async (req, res) => {
  const result = await forgotPassword(req.body);
  return sendResponse(res, {
    message: result.message,
    data: result.resetToken ? { resetToken: result.resetToken } : null,
  });
};

export const resetPasswordController = async (req, res) => {
  const result = await resetPassword(req.body);
  return sendResponse(res, {
    message: result.message,
  });
};

export const refreshTokenController = async (req, res) => {
  const result = await refreshAccessToken(req.body);
  return sendResponse(res, {
    message: "Access token refreshed",
    data: result,
  });
};

export const logoutController = async (req, res) => {
  const result = await logoutUser(req.body, req.user);
  return sendResponse(res, {
    message: result.message,
  });
};
