import { Router } from "express";
import { authorize, protect, requireActive } from "../../middlewares/auth.js";
import { catchAsync } from "../../utils/catchAsync.js";
import { ROLES } from "../../constants/domain.js";
import {
  adminDashboardController,
  adminAuditLogsController,
  adminDisputesController,
  adminFinancialController,
  adminFleetController,
  adminLiveTrackingController,
  adminNotificationsController,
  adminPromotionsController,
  adminReportsController,
  adminReviewsController,
  adminServiceCatalogController,
  adminServiceRequestsController,
  adminSettingsController,
  adminSupportTicketsController,
  adminUsersController,
  approveMechanicController,
  createAdminDisputeController,
  createAdminPromotionController,
  createAdminServiceCatalogController,
  mechanicReviewQueueController,
  rejectMechanicController,
  updateAdminPromotionController,
  updateAdminReviewController,
  updateAdminServiceCatalogController,
  updateAdminDisputeController,
  updateAdminSupportTicketController,
  updateUserStatusController,
} from "./admin.controller.js";

const router = Router();

router.use(catchAsync(protect));
router.use(catchAsync(requireActive));
router.use(catchAsync(authorize(ROLES.ADMIN)));

router.get("/dashboard", catchAsync(adminDashboardController));
router.get("/service-requests", catchAsync(adminServiceRequestsController));
router.get("/users", catchAsync(adminUsersController));
router.get("/fleet", catchAsync(adminFleetController));
router.get("/financial", catchAsync(adminFinancialController));
router.get("/live-tracking", catchAsync(adminLiveTrackingController));
router.get("/reports", catchAsync(adminReportsController));
router.get("/audit-log", catchAsync(adminAuditLogsController));
router.get("/settings", catchAsync(adminSettingsController));
router.get("/support", catchAsync(adminSupportTicketsController));
router.patch("/support/:ticketId", catchAsync(updateAdminSupportTicketController));
router.get("/disputes", catchAsync(adminDisputesController));
router.post("/disputes", catchAsync(createAdminDisputeController));
router.patch("/disputes/:disputeId", catchAsync(updateAdminDisputeController));
router.get("/notifications", catchAsync(adminNotificationsController));
router.get("/service-catalog", catchAsync(adminServiceCatalogController));
router.post("/service-catalog", catchAsync(createAdminServiceCatalogController));
router.patch(
  "/service-catalog/:serviceId",
  catchAsync(updateAdminServiceCatalogController)
);
router.get("/promotions", catchAsync(adminPromotionsController));
router.post("/promotions", catchAsync(createAdminPromotionController));
router.patch(
  "/promotions/:promotionId",
  catchAsync(updateAdminPromotionController)
);
router.get("/reviews", catchAsync(adminReviewsController));
router.patch("/reviews/:reviewId", catchAsync(updateAdminReviewController));
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
