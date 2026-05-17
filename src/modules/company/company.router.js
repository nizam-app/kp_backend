import { Router } from "express";
import { catchAsync } from "../../utils/catchAsync.js";
import { authorize, protect, requireActive } from "../../middlewares/auth.js";
import { ROLES } from "../../constants/domain.js";
import {
  companyAssignMechanicController,
  companyApproveJobCompletionController,
  companyCancelInviteController,
  companyCreateInviteController,
  companyDashboardController,
  companyEarningJobsController,
  companyEarningsSummaryController,
  companyFeedController,
  companyFeedSummaryController,
  companyQuotesController,
  companyJobByIdController,
  companyJobsController,
  companyTeamController,
  companyTeamMemberByIdController,
  companyRemoveTeamMemberController,
} from "./company.controller.js";

const router = Router();

router.use(catchAsync(protect));
router.use(catchAsync(requireActive));
router.use(catchAsync(authorize(ROLES.COMPANY)));

router.get("/dashboard", catchAsync(companyDashboardController));
router.get("/feed/summary", catchAsync(companyFeedSummaryController));
router.get("/quotes", catchAsync(companyQuotesController));
router.get("/feed", catchAsync(companyFeedController));
router.get("/jobs", catchAsync(companyJobsController));
router.get("/jobs/:jobId", catchAsync(companyJobByIdController));
router.post("/jobs/:jobId/assign", catchAsync(companyAssignMechanicController));
router.patch("/jobs/:jobId/complete/approve", catchAsync(companyApproveJobCompletionController));
router.get("/team", catchAsync(companyTeamController));
router.get("/team/members/:mechanicId", catchAsync(companyTeamMemberByIdController));
router.delete("/team/members/:mechanicId", catchAsync(companyRemoveTeamMemberController));
router.post("/team/invitations", catchAsync(companyCreateInviteController));
router.delete("/team/invitations/:inviteId", catchAsync(companyCancelInviteController));
router.get("/earnings/summary", catchAsync(companyEarningsSummaryController));
router.get("/earnings/jobs", catchAsync(companyEarningJobsController));

export default router;
