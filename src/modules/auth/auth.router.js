import { Router } from "express";
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

const router = Router();

router.post("/register", catchAsync(register));
router.post("/login", catchAsync(login));
router.post("/forgot-password", catchAsync(forgotPasswordController));
router.post("/reset-password", catchAsync(resetPasswordController));
router.post("/refresh-token", catchAsync(refreshTokenController));
router.post("/logout", catchAsync(protect), catchAsync(logoutController));

export default router;
