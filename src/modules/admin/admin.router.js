import { Router } from "express";
import { authorize, protect, requireActive } from "../../middlewares/auth.js";
import { catchAsync } from "../../utils/catchAsync.js";
import { ROLES } from "../../constants/domain.js";
import {
  approveMechanicController,
  mechanicReviewQueueController,
  rejectMechanicController,
  updateUserStatusController,
} from "./admin.controller.js";

const router = Router();

router.use(catchAsync(protect));
router.use(catchAsync(requireActive));
router.use(catchAsync(authorize(ROLES.ADMIN)));

router.get(
  "/mechanics/review-queue",
  catchAsync(mechanicReviewQueueController)
);
router.patch(
  "/mechanics/:userId/approve",
  catchAsync(approveMechanicController)
);
router.patch(
  "/mechanics/:userId/reject",
  catchAsync(rejectMechanicController)
);
router.patch("/users/:userId/status", catchAsync(updateUserStatusController));

export default router;
