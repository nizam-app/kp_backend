import { Router } from "express";
import { catchAsync } from "../../utils/catchAsync.js";
import { protect, requireActive } from "../../middlewares/auth.js";
import {
  listChatThreadsController,
  listJobMessagesController,
  markJobMessagesReadController,
  sendJobMessageController,
} from "./chat.controller.js";

const router = Router();

router.use(catchAsync(protect));
router.use(catchAsync(requireActive));

router.get("/threads", catchAsync(listChatThreadsController));
router.get("/jobs/:jobId/messages", catchAsync(listJobMessagesController));
router.post("/jobs/:jobId/messages", catchAsync(sendJobMessageController));
router.patch("/jobs/:jobId/read", catchAsync(markJobMessagesReadController));

export default router;
