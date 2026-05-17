import AppError from "../../utils/AppError.js";
import { sendResponse } from "../../utils/sendResponse.js";
import { uploadProfileImageBuffer } from "../media/media.service.js";
import { ROLES } from "../../constants/domain.js";
import {
  forgotPassword,
  loginUser,
  logoutUser,
  refreshAccessToken,
  registerUser,
  resetPassword,
} from "./auth.service.js";

const parseJsonIfString = (value, fieldName) => {
  if (value === undefined || value === null || typeof value !== "string") return value;
  const raw = value.trim();
  if (!raw) return value;
  try {
    return JSON.parse(raw);
  } catch {
    throw new AppError(`${fieldName} must be valid JSON`, 400);
  }
};

const numericFields = [
  "hourlyRate",
  "emergencyRate",
  "emergencySurcharge",
  "callOutFee",
  "callOutCharge",
  "coverageRadius",
  "serviceRadiusMiles",
];

/**
 * JSON body as today, or `multipart/form-data` with the same fields as text parts
 * plus optional image field **`file`** or **`profilePhoto`** (mechanic / mechanic employee only).
 */
const buildRegisterPayload = async (req) => {
  const body = { ...(req.body || {}) };

  if (typeof body.skills === "string") {
    const s = body.skills.trim();
    if (s.startsWith("[")) {
      body.skills = parseJsonIfString(body.skills, "skills");
    } else {
      body.skills = s.split(",").map((x) => `${x}`.trim().toUpperCase()).filter(Boolean);
    }
  }

  for (const key of numericFields) {
    if (body[key] === undefined || body[key] === null || body[key] === "") continue;
    if (typeof body[key] === "string") {
      const n = Number(body[key]);
      if (!Number.isFinite(n)) {
        throw new AppError(`${key} must be a number`, 400);
      }
      body[key] = n;
    }
  }

  if (body.role !== undefined) {
    body.role = `${body.role}`.trim().toUpperCase();
  }
  if (body.businessType !== undefined) {
    body.businessType = `${body.businessType}`.trim().toUpperCase();
  }

  const files = Array.isArray(req.files) ? req.files : [];
  const imageFile = files.find((f) => f && (f.fieldname === "file" || f.fieldname === "profilePhoto"));
  if (imageFile?.buffer?.length) {
    const role = body.role;
    if (role !== ROLES.MECHANIC && role !== ROLES.MECHANIC_EMPLOYEE) {
      throw new AppError(
        "Profile image upload on register is only supported for MECHANIC and MECHANIC_EMPLOYEE",
        400
      );
    }
    const uploaded = await uploadProfileImageBuffer(imageFile.buffer, imageFile.mimetype);
    body.profilePhotoUrl = uploaded.url;
  }

  return body;
};

export const register = async (req, res) => {
  const payload = await buildRegisterPayload(req);
  const result = await registerUser(payload);
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
