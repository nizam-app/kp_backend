import AppError from "../utils/AppError.js";
import { verifyAccessToken } from "../utils/token.js";
import { User } from "../modules/user/user.model.js";
import { USER_STATUS } from "../constants/domain.js";

const parseBearerToken = (authHeader = "") => {
  const [scheme, token] = authHeader.split(" ");
  if (scheme !== "Bearer" || !token) return null;
  return token;
};

export const protect = async (req, _res, next) => {
  const token = parseBearerToken(req.headers.authorization);
  if (!token) return next(new AppError("Unauthorized", 401));

  const decoded = verifyAccessToken(token);
  const user = await User.findById(decoded.sub);
  if (!user) return next(new AppError("User not found", 404));
  if ([USER_STATUS.BLOCKED, USER_STATUS.SUSPENDED].includes(user.status)) {
    return next(new AppError("Account is not active", 403));
  }

  req.user = user;
  next();
};

export const requireActive = (req, _res, next) => {
  if (!req.user) return next(new AppError("Unauthorized", 401));
  if (req.user.status !== USER_STATUS.ACTIVE) {
    return next(new AppError("Account is not active", 403));
  }
  next();
};

export const authorize =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user) return next(new AppError("Unauthorized", 401));
    if (!roles.includes(req.user.role)) {
      return next(new AppError("Forbidden", 403));
    }
    next();
  };
