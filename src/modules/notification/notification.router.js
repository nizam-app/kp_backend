import { Router } from "express";
import { catchAsync } from "../../utils/catchAsync.js";
import { protect } from "../../middlewares/auth.js";
import {
  deleteNotificationController,
  getNotificationController,
  listDeviceTokensController,
  listNotificationsController,
  markAllNotificationsReadController,
  markNotificationReadController,
  registerDeviceTokenController,
} from "./notification.controller.js";

const router = Router();

router.use(catchAsync(protect));

router.get("/", catchAsync(listNotificationsController));
router.patch("/read-all", catchAsync(markAllNotificationsReadController));
router.get("/device-tokens", catchAsync(listDeviceTokensController));
router.post("/device-tokens", catchAsync(registerDeviceTokenController));
router.get("/:id", catchAsync(getNotificationController));
router.patch("/:id/read", catchAsync(markNotificationReadController));
router.delete("/:id", catchAsync(deleteNotificationController));

export default router;
