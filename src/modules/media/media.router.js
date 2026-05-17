import { Router } from "express";
import { catchAsync } from "../../utils/catchAsync.js";
import { protect } from "../../middlewares/auth.js";
import { requireActive } from "../../middlewares/auth.js";
import { handleProfileImageMulterError } from "../../config/profileImageUpload.js";
import { uploadProfileImageController } from "./media.controller.js";

const router = Router();

router.post(
  "/profile-image",
  catchAsync(protect),
  catchAsync(requireActive),
  handleProfileImageMulterError,
  catchAsync(uploadProfileImageController)
);

export default router;
