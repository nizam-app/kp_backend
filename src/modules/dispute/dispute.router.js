import { Router } from "express";
import { catchAsync } from "../../utils/catchAsync.js";
import { authorize, protect, requireActive } from "../../middlewares/auth.js";
import { ROLES } from "../../constants/domain.js";
import { handleDisputeEvidenceUpload } from "../../config/disputeEvidenceUpload.js";
import {
  addDisputeEvidenceController,
  addDisputeMessageController,
  appealDisputeController,
  assignDisputeController,
  createDisputeController,
  decideDisputeController,
  executeDisputeFinancialController,
  approveDisputeFinancialController,
  escalateSupportController,
  getDisputeController,
  listDisputesController,
  listEligibleDisputeJobsController,
  transitionDisputeController,
  downloadDisputeEvidenceController,
  reviewDisputeEvidenceController,
} from "./dispute.controller.js";

const router = Router();
const participants = [
  ROLES.FLEET,
  ROLES.COMPANY,
  ROLES.MECHANIC,
  ROLES.MECHANIC_EMPLOYEE,
  ROLES.ADMIN,
];

router.use(catchAsync(protect));
router.use(catchAsync(requireActive));

router.get("/", catchAsync(authorize(...participants)), catchAsync(listDisputesController));
router.post("/", catchAsync(authorize(...participants)), catchAsync(createDisputeController));
router.get(
  "/eligible-jobs",
  catchAsync(authorize(ROLES.FLEET, ROLES.COMPANY, ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE)),
  catchAsync(listEligibleDisputeJobsController)
);
router.get("/:disputeId", catchAsync(authorize(...participants)), catchAsync(getDisputeController));
router.post(
  "/:disputeId/messages",
  catchAsync(authorize(...participants)),
  catchAsync(addDisputeMessageController)
);
router.post(
  "/:disputeId/evidence",
  catchAsync(authorize(...participants)),
  handleDisputeEvidenceUpload,
  catchAsync(addDisputeEvidenceController)
);
router.get(
  "/:disputeId/evidence/:evidenceId/download",
  catchAsync(authorize(...participants)),
  catchAsync(downloadDisputeEvidenceController)
);
router.patch(
  "/:disputeId/evidence/:evidenceId/review",
  catchAsync(authorize(ROLES.ADMIN)),
  catchAsync(reviewDisputeEvidenceController)
);
router.post(
  "/:disputeId/appeal",
  catchAsync(authorize(ROLES.FLEET, ROLES.COMPANY, ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE)),
  catchAsync(appealDisputeController)
);
router.post(
  "/:disputeId/assign",
  catchAsync(authorize(ROLES.ADMIN)),
  catchAsync(assignDisputeController)
);
router.post(
  "/:disputeId/transition",
  catchAsync(authorize(ROLES.ADMIN)),
  catchAsync(transitionDisputeController)
);
router.post(
  "/:disputeId/decision",
  catchAsync(authorize(ROLES.ADMIN)),
  catchAsync(decideDisputeController)
);
router.post(
  "/:disputeId/financial-actions/:actionId/execute",
  catchAsync(authorize(ROLES.ADMIN)),
  catchAsync(executeDisputeFinancialController)
);
router.post(
  "/:disputeId/financial-actions/:actionId/approve",
  catchAsync(authorize(ROLES.ADMIN)),
  catchAsync(approveDisputeFinancialController)
);
router.post(
  "/support/:ticketId/escalate",
  catchAsync(authorize(...participants)),
  catchAsync(escalateSupportController)
);

export default router;
