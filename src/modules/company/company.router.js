import { Router } from "express";
import { catchAsync } from "../../utils/catchAsync.js";
import { authorize, protect, requireActive } from "../../middlewares/auth.js";
import { ROLES } from "../../constants/domain.js";
import {
  companyAssignMechanicController,
  companyCancelInviteController,
  companyCreateInviteController,
  companyDashboardController,
  companyEarningJobsController,
  companyEarningsSummaryController,
  companyFeedController,
  companyJobByIdController,
  companyJobsController,
  companyTeamController,
} from "./company.controller.js";

const router = Router();

router.use(catchAsync(protect));
router.use(catchAsync(requireActive));
router.use(catchAsync(authorize(ROLES.COMPANY)));

router.get("/dashboard", catchAsync(companyDashboardController));
router.get("/feed", catchAsync(companyFeedController));
router.get("/jobs", catchAsync(companyJobsController));
router.get("/jobs/:jobId", catchAsync(companyJobByIdController));
router.post("/jobs/:jobId/assign", catchAsync(companyAssignMechanicController));
router.get("/team", catchAsync(companyTeamController));
router.post("/team/invitations", catchAsync(companyCreateInviteController));
router.delete("/team/invitations/:inviteId", catchAsync(companyCancelInviteController));
router.get("/earnings/summary", catchAsync(companyEarningsSummaryController));
router.get("/earnings/jobs", catchAsync(companyEarningJobsController));

export default router;
