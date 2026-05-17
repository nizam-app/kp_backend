import { Router } from "express";
import multer from "multer";
import { catchAsync } from "../../utils/catchAsync.js";
import { protect, requireActive } from "../../middlewares/auth.js";
import {
  listChatThreadsController,
  listJobMessagesController,
  markJobMessagesReadController,
  sendJobMessageController,
  uploadJobChatAttachmentController,
} from "./chat.controller.js";

const chatImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith("image/")) {
      return cb(null, true);
    }
    cb(new Error("Only image uploads are allowed"));
  },
});

const router = Router();

router.use(catchAsync(protect));
router.use(catchAsync(requireActive));

router.get("/threads", catchAsync(listChatThreadsController));
router.get("/jobs/:jobId/messages", catchAsync(listJobMessagesController));
router.post(
  "/jobs/:jobId/attachments",
  (req, res, next) => {
    chatImageUpload.single("file")(req, res, (err) => {
      if (err) {
        return res.status(400).json({
          status: "error",
          message: err.message || "File upload error",
        });
      }
      next();
    });
  },
  catchAsync(uploadJobChatAttachmentController)
);
router.post("/jobs/:jobId/messages", catchAsync(sendJobMessageController));
router.patch("/jobs/:jobId/read", catchAsync(markJobMessagesReadController));

export default router;
