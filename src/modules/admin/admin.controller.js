import { sendResponse } from "../../utils/sendResponse.js";
import {
  createAdminDispute,
  createAdminPromotion,
  createAdminServiceCatalogItem,
  approveMechanic,
  getAdminDashboard,
  getAdminFinancialOverview,
  getAdminLiveTracking,
  getAdminReports,
  getAdminSettings,
  listAdminFleet,
  listAdminDisputes,
  listAdminNotifications,
  listAdminPromotions,
  listAdminReviews,
  listAdminServiceCatalog,
  listAdminAuditLogs,
  listAdminSupportTickets,
  listAdminServiceRequests,
  listAdminUsers,
  listMechanicReviewQueue,
  rejectMechanic,
  updateAdminPromotion,
  updateAdminReview,
  updateAdminServiceCatalogItem,
  updateAdminDispute,
  updateAdminSupportTicket,
  updateUserStatus,
} from "./admin.service.js";

export const adminDashboardController = async (_req, res) => {
  const result = await getAdminDashboard();
  return sendResponse(res, {
    message: "Admin dashboard fetched",
    data: result,
  });
};

export const adminServiceRequestsController = async (req, res) => {
  const result = await listAdminServiceRequests(req.query);
  return sendResponse(res, {
    message: "Admin service requests fetched",
    data: {
      items: result.items,
      stats: result.stats,
    },
    meta: result.meta,
  });
};

export const adminUsersController = async (req, res) => {
  const result = await listAdminUsers(req.query);
  return sendResponse(res, {
    message: "Admin users fetched",
    data: {
      items: result.items,
      stats: result.stats,
    },
    meta: result.meta,
  });
};

export const adminFleetController = async (req, res) => {
  const result = await listAdminFleet(req.query);
  return sendResponse(res, {
    message: "Admin fleet fetched",
    data: result,
  });
};

export const adminFinancialController = async (req, res) => {
  const result = await getAdminFinancialOverview(req.query);
  return sendResponse(res, {
    message: "Admin financial overview fetched",
    data: result,
  });
};

export const adminLiveTrackingController = async (_req, res) => {
  const result = await getAdminLiveTracking();
  return sendResponse(res, {
    message: "Admin live tracking fetched",
    data: result,
  });
};

export const adminSupportTicketsController = async (req, res) => {
  const result = await listAdminSupportTickets(req.query);
  return sendResponse(res, {
    message: "Admin support tickets fetched",
    data: {
      items: result.items,
      stats: result.stats,
    },
    meta: result.meta,
  });
};

export const updateAdminSupportTicketController = async (req, res) => {
  const result = await updateAdminSupportTicket(req.params.ticketId, req.body);
  return sendResponse(res, {
    message: "Admin support ticket updated",
    data: result,
  });
};

export const adminDisputesController = async (req, res) => {
  const result = await listAdminDisputes(req.query);
  return sendResponse(res, {
    message: "Admin disputes fetched",
    data: {
      items: result.items,
      stats: result.stats,
    },
    meta: result.meta,
  });
};

export const createAdminDisputeController = async (req, res) => {
  const result = await createAdminDispute(req.body);
  return sendResponse(res, {
    statusCode: 201,
    message: "Admin dispute created",
    data: result,
  });
};

export const updateAdminDisputeController = async (req, res) => {
  const result = await updateAdminDispute(req.params.disputeId, req.body);
  return sendResponse(res, {
    message: "Admin dispute updated",
    data: result,
  });
};

export const adminNotificationsController = async (_req, res) => {
  const result = await listAdminNotifications();
  return sendResponse(res, {
    message: "Admin notifications fetched",
    data: result,
  });
};

export const adminServiceCatalogController = async (req, res) => {
  const result = await listAdminServiceCatalog(req.query);
  return sendResponse(res, {
    message: "Admin service catalog fetched",
    data: result,
  });
};

export const createAdminServiceCatalogController = async (req, res) => {
  const result = await createAdminServiceCatalogItem(req.body);
  return sendResponse(res, {
    statusCode: 201,
    message: "Admin service created",
    data: result,
  });
};

export const updateAdminServiceCatalogController = async (req, res) => {
  const result = await updateAdminServiceCatalogItem(req.params.serviceId, req.body);
  return sendResponse(res, {
    message: "Admin service updated",
    data: result,
  });
};

export const adminPromotionsController = async (req, res) => {
  const result = await listAdminPromotions(req.query);
  return sendResponse(res, {
    message: "Admin promotions fetched",
    data: result,
  });
};

export const createAdminPromotionController = async (req, res) => {
  const result = await createAdminPromotion(req.body);
  return sendResponse(res, {
    statusCode: 201,
    message: "Admin promotion created",
    data: result,
  });
};

export const updateAdminPromotionController = async (req, res) => {
  const result = await updateAdminPromotion(req.params.promotionId, req.body);
  return sendResponse(res, {
    message: "Admin promotion updated",
    data: result,
  });
};

export const adminReviewsController = async (req, res) => {
  const result = await listAdminReviews(req.query);
  return sendResponse(res, {
    message: "Admin reviews fetched",
    data: result,
  });
};

export const updateAdminReviewController = async (req, res) => {
  const result = await updateAdminReview(req.params.reviewId, req.body);
  return sendResponse(res, {
    message: "Admin review updated",
    data: result,
  });
};

export const adminAuditLogsController = async (req, res) => {
  const result = await listAdminAuditLogs(req.query);
  return sendResponse(res, {
    message: "Admin audit logs fetched",
    data: result,
  });
};

export const adminReportsController = async (req, res) => {
  const result = await getAdminReports(req.query);
  return sendResponse(res, {
    message: "Admin reports fetched",
    data: result,
  });
};

export const adminSettingsController = async (req, res) => {
  const result = await getAdminSettings(req.user);
  return sendResponse(res, {
    message: "Admin settings fetched",
    data: result,
  });
};

export const mechanicReviewQueueController = async (req, res) => {
  const result = await listMechanicReviewQueue(req.query);
  return sendResponse(res, {
    message: "Mechanic review queue fetched",
    data: result.items,
    meta: result.meta,
  });
};

export const approveMechanicController = async (req, res) => {
  const result = await approveMechanic(req.params.userId, req.body);
  return sendResponse(res, {
    message: "Mechanic approved",
    data: result,
  });
};

export const rejectMechanicController = async (req, res) => {
  const result = await rejectMechanic(req.params.userId, req.body);
  return sendResponse(res, {
    message: "Mechanic rejected",
    data: result,
  });
};

export const updateUserStatusController = async (req, res) => {
  const result = await updateUserStatus(req.params.userId, req.body);
  return sendResponse(res, {
    message: "User status updated",
    data: result,
  });
};
