import { Router } from "express";
import multer from "multer";
import { catchAsync } from "../../utils/catchAsync.js";
import { protect, requireActive } from "../../middlewares/auth.js";
import { uploadProfileImageController } from "./media.controller.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith("image/")) {
      return cb(null, true);
    }
    cb(new Error("Only image uploads are allowed"));
  },
});

const router = Router();

router.post(
  "/profile-image",
  catchAsync(protect),
  catchAsync(requireActive),
  (req, res, next) => {
    upload.single("file")(req, res, (err) => {
      if (err) {
        return res.status(400).json({
          status: "error",
          message: err.message || "File upload error",
        });
      }
      next();
    });
  },
  catchAsync(uploadProfileImageController)
);

export default router;
