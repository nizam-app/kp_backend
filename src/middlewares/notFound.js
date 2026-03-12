import AppError from "../utils/AppError.js";

export const notFound = (req, res, next) => {
  next(new AppError(`Can't find ${req.originalUrl}`, 404));
};
