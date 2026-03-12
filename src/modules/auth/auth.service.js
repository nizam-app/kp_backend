import crypto from "crypto";
import AppError from "../../utils/AppError.js";
import { User } from "../user/user.model.js";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../../utils/token.js";
import {
  MECHANIC_VERIFICATION_STATUS,
  ROLES,
  USER_STATUS,
} from "../../constants/domain.js";

const sanitizeUser = (userDoc) => userDoc.toObject();
const hashToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

const assertRoleAllowed = (role) => {
  if (![ROLES.FLEET, ROLES.MECHANIC].includes(role)) {
    throw new AppError("Invalid role. Allowed: FLEET, MECHANIC", 400);
  }
};

const setRefreshTokenHash = async (user, refreshToken) => {
  user.refreshTokenHash = hashToken(refreshToken);
  await user.save({ validateBeforeSave: false });
};

const issueAuthTokens = async (user) => {
  const tokenPayload = { sub: user._id.toString(), role: user.role };
  const accessToken = signAccessToken(tokenPayload);
  const refreshToken = signRefreshToken(tokenPayload);
  await setRefreshTokenHash(user, refreshToken);
  return { accessToken, refreshToken };
};

const resolveNextStep = (user) => {
  if (user.status === USER_STATUS.PENDING_REVIEW) return "UNDER_REVIEW";
  if (user.role === ROLES.FLEET && !user.fleetProfile?.profileCompleted) {
    return "COMPLETE_PROFILE";
  }
  if (user.role === ROLES.MECHANIC && !user.mechanicProfile?.profileCompleted) {
    return "COMPLETE_PROFILE";
  }
  return "GO_DASHBOARD";
};

const applyRoleProfile = (role, payload) => {
  if (role === ROLES.FLEET) {
    return {
      fleetProfile: {
        companyName: payload.companyName,
        contactName: payload.contactName || payload.fullName,
        contactRole: payload.contactRole,
        phone: payload.phone,
        regNumber: payload.regNumber,
        vatNumber: payload.vatNumber,
        fleetSize: payload.fleetSize,
        defaultAddress: payload.defaultAddress,
        billingAddress: payload.billingAddress,
      },
    };
  }

  return {
    mechanicProfile: {
      displayName: payload.displayName || payload.fullName,
      businessName: payload.businessName,
      phone: payload.phone,
      baseLocationText: payload.baseLocationText,
      hourlyRate: payload.hourlyRate,
      emergencyRate: payload.emergencyRate,
      callOutFee: payload.callOutFee,
      serviceRadiusMiles: payload.serviceRadiusMiles,
      skills: payload.skills,
      verification: {
        status: MECHANIC_VERIFICATION_STATUS.SUBMITTED,
        submittedAt: new Date(),
      },
    },
  };
};

export const registerUser = async (payload) => {
  const { email, password, role, confirmPassword } = payload;
  if (!email || !password || !role) {
    throw new AppError("email, password, role are required", 400);
  }
  if (confirmPassword !== undefined && password !== confirmPassword) {
    throw new AppError("password and confirmPassword do not match", 400);
  }

  assertRoleAllowed(role);

  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) throw new AppError("Email already in use", 409);

  const profileFields = applyRoleProfile(role, payload);
  const user = await User.create({
    email,
    password,
    role,
    status: role === ROLES.MECHANIC ? USER_STATUS.PENDING_REVIEW : USER_STATUS.ACTIVE,
    ...profileFields,
  });

  const { accessToken, refreshToken } = await issueAuthTokens(user);
  const nextStep = resolveNextStep(user);

  return { user: sanitizeUser(user), accessToken, refreshToken, nextStep };
};

export const loginUser = async ({ email, password }) => {
  if (!email || !password) {
    throw new AppError("email and password are required", 400);
  }

  const user = await User.findOne({ email: email.toLowerCase() }).select(
    "+password"
  );
  if (!user) throw new AppError("Invalid credentials", 401);
  if ([USER_STATUS.BLOCKED, USER_STATUS.SUSPENDED].includes(user.status)) {
    throw new AppError("Account is not active", 403);
  }

  const isMatch = await user.comparePassword(password);
  if (!isMatch) throw new AppError("Invalid credentials", 401);

  const { accessToken, refreshToken } = await issueAuthTokens(user);
  const nextStep = resolveNextStep(user);

  user.password = undefined;
  return { user: sanitizeUser(user), accessToken, refreshToken, nextStep };
};

export const forgotPassword = async ({ email }) => {
  if (!email) throw new AppError("email is required", 400);

  const user = await User.findOne({ email: email.toLowerCase() }).select(
    "+passwordResetToken +passwordResetExpires"
  );

  if (!user) {
    return {
      message:
        "If this email exists, a reset link/token has been generated.",
    };
  }

  const resetToken = user.createPasswordResetToken();
  await user.save({ validateBeforeSave: false });

  return {
    message: "Reset token generated. Send this via email provider in production.",
    resetToken,
  };
};

export const resetPassword = async ({ token, newPassword }) => {
  if (!token || !newPassword) {
    throw new AppError("token and newPassword are required", 400);
  }

  const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

  const user = await User.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpires: { $gt: new Date() },
  }).select("+passwordResetToken +passwordResetExpires");

  if (!user) throw new AppError("Token invalid or expired", 400);

  user.password = newPassword;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  user.refreshTokenHash = undefined;
  await user.save();

  return { message: "Password reset successful" };
};

export const refreshAccessToken = async ({ refreshToken }) => {
  if (!refreshToken) throw new AppError("refreshToken is required", 400);

  const decoded = verifyRefreshToken(refreshToken);
  const user = await User.findById(decoded.sub).select("+refreshTokenHash");
  if (!user) throw new AppError("User not found", 404);
  if ([USER_STATUS.BLOCKED, USER_STATUS.SUSPENDED].includes(user.status)) {
    throw new AppError("Account is not active", 403);
  }
  if (!user.refreshTokenHash || user.refreshTokenHash !== hashToken(refreshToken)) {
    throw new AppError("Invalid refresh token", 401);
  }

  const tokens = await issueAuthTokens(user);

  return tokens;
};

export const logoutUser = async ({ refreshToken }, authUser) => {
  if (!refreshToken) throw new AppError("refreshToken is required", 400);

  const decoded = verifyRefreshToken(refreshToken);
  if (decoded.sub !== authUser._id.toString()) {
    throw new AppError("Forbidden", 403);
  }

  const user = await User.findById(authUser._id).select("+refreshTokenHash");
  if (!user) throw new AppError("User not found", 404);

  if (user.refreshTokenHash === hashToken(refreshToken)) {
    user.refreshTokenHash = undefined;
    await user.save({ validateBeforeSave: false });
  }

  return { message: "Logged out successfully" };
};
