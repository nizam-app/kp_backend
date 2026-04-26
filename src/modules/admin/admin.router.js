import { Router } from "express";
import { authorize, protect, requireActive } from "../../middlewares/auth.js";
import { catchAsync } from "../../utils/catchAsync.js";
import { ROLES } from "../../constants/domain.js";
import {
  adminDashboardController,adminAuditLogsController,adminDisputesController,adminFinancialController,adminFleetController,adminLiveTrackingController,
  adminNotificationsController,adminPromotionsController,adminReportsController,adminReviewsController,adminServiceCatalogController,
  adminServiceRequestByIdController,adminServiceRequestsController,adminSettingsController,adminSupportTicketsController,adminUserByIdController,adminUserMembersController,adminUsersController,approveMechanicController,
  createAdminFinancialInvoiceController,createAdminFleetController,createAdminFleetVehicleController,createAdminUserController,
  createAdminDisputeController,createAdminPromotionController,createAdminServiceCatalogController,createAdminServiceRequestInvoiceController,
  deleteAdminUserController,
  deleteAdminFleetController,
  deleteAdminPromotionController,
  mechanicReviewQueueController,rejectMechanicController,
  deleteAdminServiceRequestController,sendAdminServiceRequestMessageController,
  resetAdminUserPasswordController,sendAdminUserMessageController,
  markAdminNotificationReadController,markAllAdminNotificationsReadController,removeAdminNotificationController,
  exportAdminFinancialController,exportAdminReportsController,
  updateAdminPromotionController,updateAdminReviewController,updateAdminServiceCatalogController,updateAdminDisputeController,
  updateAdminFleetController,updateAdminFleetVehicleController,updateAdminServiceRequestController,updateAdminSettingsController,updateAdminSupportTicketController,
  updateAdminUserController,updateUserStatusController,
  adminReviewByIdController,deleteAdminReviewController,
} from "./admin.controller.js";

const router = Router();

router.use(catchAsync(protect));
router.use(catchAsync(requireActive));
router.use(catchAsync(authorize(ROLES.ADMIN)));

router.get("/dashboard", catchAsync(adminDashboardController));
router.get("/service-requests", catchAsync(adminServiceRequestsController));
router.get("/service-requests/:jobId", catchAsync(adminServiceRequestByIdController));
router.patch("/service-requests/:jobId", catchAsync(updateAdminServiceRequestController));
router.post("/service-requests/:jobId/message", catchAsync(sendAdminServiceRequestMessageController));
router.post("/service-requests/:jobId/invoice", catchAsync(createAdminServiceRequestInvoiceController));
router.delete("/service-requests/:jobId", catchAsync(deleteAdminServiceRequestController));
router.get("/users", catchAsync(adminUsersController));
router.post("/users", catchAsync(createAdminUserController));
router.get("/users/:userId", catchAsync(adminUserByIdController));
router.get("/users/:userId/members", catchAsync(adminUserMembersController));
router.patch("/users/:userId", catchAsync(updateAdminUserController));
router.post("/users/:userId/reset-password", catchAsync(resetAdminUserPasswordController));
router.post("/users/:userId/message", catchAsync(sendAdminUserMessageController));
router.delete("/users/:userId", catchAsync(deleteAdminUserController));
router.get("/fleet", catchAsync(adminFleetController));
router.post("/fleet", catchAsync(createAdminFleetController));
router.patch("/fleet/:fleetId", catchAsync(updateAdminFleetController));
router.delete("/fleet/:fleetId", catchAsync(deleteAdminFleetController));
router.post("/fleet/:fleetId/vehicles", catchAsync(createAdminFleetVehicleController));
router.patch("/fleet/:fleetId/vehicles/:vehicleId", catchAsync(updateAdminFleetVehicleController));
router.get("/financial", catchAsync(adminFinancialController));
router.post("/financial/invoices", catchAsync(createAdminFinancialInvoiceController));
router.get("/financial/export", catchAsync(exportAdminFinancialController));
router.get("/live-tracking", catchAsync(adminLiveTrackingController));
router.get("/reports", catchAsync(adminReportsController));
router.get("/reports/export", catchAsync(exportAdminReportsController));
router.get("/audit-log", catchAsync(adminAuditLogsController));
router.get("/settings", catchAsync(adminSettingsController));
router.patch("/settings", catchAsync(updateAdminSettingsController));
router.get("/support", catchAsync(adminSupportTicketsController));
router.patch("/support/:ticketId", catchAsync(updateAdminSupportTicketController));
router.get("/disputes", catchAsync(adminDisputesController));
router.post("/disputes", catchAsync(createAdminDisputeController));
router.patch("/disputes/:disputeId", catchAsync(updateAdminDisputeController));
router.get("/notifications", catchAsync(adminNotificationsController));
router.patch("/notifications/read-all", catchAsync(markAllAdminNotificationsReadController));
router.patch("/notifications/:notificationId/read", catchAsync(markAdminNotificationReadController));
router.delete("/notifications/:notificationId", catchAsync(removeAdminNotificationController));
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
router.delete("/promotions/:promotionId", catchAsync(deleteAdminPromotionController));
router.get("/reviews", catchAsync(adminReviewsController));
router.get("/reviews/:reviewId", catchAsync(adminReviewByIdController));
router.patch("/reviews/:reviewId", catchAsync(updateAdminReviewController));
router.delete("/reviews/:reviewId", catchAsync(deleteAdminReviewController));
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


