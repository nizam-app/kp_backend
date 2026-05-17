import { Router } from "express";
import multer from "multer";
import { catchAsync } from "../../utils/catchAsync.js";
import { protect } from "../../middlewares/auth.js";
import {
  forgotPasswordController,
  login,
  logoutController,
  refreshTokenController,
  register,
  resetPasswordController,
} from "./auth.controller.js";

const registerMultipart = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith("image/")) {
      return cb(null, true);
    }
    cb(new Error("Only image uploads are allowed"));
  },
});

const parseRegisterMultipart = (req, res, next) => {
  const ct = `${req.headers["content-type"] || ""}`.toLowerCase();
  if (!ct.includes("multipart/form-data")) {
    return next();
  }
  registerMultipart.any()(req, res, (err) => {
    if (err) {
      return res.status(400).json({
        status: "error",
        message: err.message || "File upload error",
      });
    }
    const files = Array.isArray(req.files) ? req.files : [];
    const bad = files.find((f) => f && !["file", "profilePhoto"].includes(f.fieldname));
    if (bad) {
      return res.status(400).json({
        status: "error",
        message: 'Unexpected file field. Use "file" or "profilePhoto" for the profile image.',
      });
    }
    next();
  });
};

const router = Router();

router.post("/register", parseRegisterMultipart, catchAsync(register));
router.post("/login", catchAsync(login));
router.post("/forgot-password", catchAsync(forgotPasswordController));
router.post("/reset-password", catchAsync(resetPasswordController));
router.post("/refresh-token", catchAsync(refreshTokenController));
router.post("/logout", catchAsync(protect), catchAsync(logoutController));

export default router;
