import { Router } from "express";
import { catchAsync } from "../../utils/catchAsync.js";
import { protect } from "../../middlewares/auth.js";
import {
  listDeviceTokensController,
  listNotificationsController,
  markNotificationReadController,
  registerDeviceTokenController,
} from "./notification.controller.js";

const router = Router();

router.use(catchAsync(protect));

router.get("/", catchAsync(listNotificationsController));
router.patch("/:id/read", catchAsync(markNotificationReadController));
router.get("/device-tokens", catchAsync(listDeviceTokensController));
router.post("/device-tokens", catchAsync(registerDeviceTokenController));

export default router;
