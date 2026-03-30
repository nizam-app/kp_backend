import { Router } from "express";
import { catchAsync } from "../../utils/catchAsync.js";
import { authorize, protect, requireActive } from "../../middlewares/auth.js";
import { ROLES } from "../../constants/domain.js";
import {
  earningJobsController,
  earningSummaryController,
} from "./earning.controller.js";

const router = Router();

router.use(catchAsync(protect));
router.use(catchAsync(requireActive));
router.use(catchAsync(authorize(ROLES.MECHANIC)));

router.get("/summary", catchAsync(earningSummaryController));
router.get("/jobs", catchAsync(earningJobsController));

export default router;
