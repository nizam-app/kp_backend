import AppError from "../utils/AppError.js";

export const globalError = (err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  const status = err.status || "error";

  // Mongoose CastError (invalid ObjectId)
  if (err.name === "CastError") {
    err = new AppError("Invalid ID format", 400);
  }

  // Mongoose duplicate key
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || "field";
    err = new AppError(`${field} already exists`, 409);
  }

  // Mongoose validation error
  if (err.name === "ValidationError") {
    const msgs = Object.values(err.errors || {}).map((e) => e.message);
    err = new AppError(msgs.join(", "), 400);
  }

  // JWT errors (optional)
  if (err.name === "JsonWebTokenError") err = new AppError("Invalid token", 401);
  if (err.name === "TokenExpiredError") err = new AppError("Token expired", 401);

  // Production-friendly response
  res.status(err.statusCode || statusCode).json({
    status: err.status || status,
    message: err.message || "Something went wrong",
  });
};
