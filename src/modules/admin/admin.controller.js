import { sendResponse } from "../../utils/sendResponse.js";
import {
  createAdminFleetCompany,
  createAdminFleetVehicle,
  createAdminFinancialInvoice,
  createAdminDispute,
  createAdminPromotion,
  createAdminServiceCatalogItem,
  createAdminServiceRequestInvoice,
  createAdminUserOrCompany,
  deleteAdminFleetCompany,
  deleteAdminUser,
  deleteAdminServiceRequest,
  approveMechanic,
  exportAdminFinancialOverview,
  exportAdminReports,
  getAdminDashboard,
  getAdminFinancialOverview,
  getAdminLiveTracking,
  getAdminReports,
  getAdminSettings,
  getAdminServiceRequestById,
  getAdminUserById,
  listAdminFleet,
  listAdminDisputes,
  listAdminNotifications,
  listAdminPromotions,
  listAdminReviews,
  listAdminServiceCatalog,
  listAdminAuditLogs,
  listAdminSupportTickets,
  listAdminServiceRequests,
  listAdminUserMembers,
  listAdminUsers,
  listMechanicReviewQueue,
  markAdminNotificationRead,
  markAllAdminNotificationsRead,
  rejectMechanic,
  removeAdminNotification,
  resetAdminUserPassword,
  sendAdminUserMessage,
  sendAdminServiceRequestMessage,
  updateAdminFleetCompany,
  updateAdminFleetVehicle,
  updateAdminServiceRequest,
  updateAdminPromotion,
  updateAdminReview,
  updateAdminServiceCatalogItem,
  updateAdminDispute,
  updateAdminSettings,
  updateAdminSupportTicket,
  updateAdminUser,
  updateUserStatus,
  deleteAdminPromotion,
  getAdminReviewById,
  deleteAdminReview,
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

export const updateAdminServiceRequestController = async (req, res) => {
  const result = await updateAdminServiceRequest(req.params.jobId, req.body, req.user);
  return sendResponse(res, {
    message: "Admin service request updated",
    data: result,
  });
};

export const adminServiceRequestByIdController = async (req, res) => {
  const result = await getAdminServiceRequestById(req.params.jobId);
  return sendResponse(res, {
    message: "Admin service request fetched",
    data: result,
  });
};

export const createAdminServiceRequestInvoiceController = async (req, res) => {
  const result = await createAdminServiceRequestInvoice(req.params.jobId, req.body, req.user);
  return sendResponse(res, {
    statusCode: 201,
    message: "Admin service request invoice created",
    data: result,
  });
};

export const sendAdminServiceRequestMessageController = async (req, res) => {
  const result = await sendAdminServiceRequestMessage(req.params.jobId, req.body, req.user);
  return sendResponse(res, {
    statusCode: 201,
    message: "Admin service request message sent",
    data: result,
  });
};

export const deleteAdminServiceRequestController = async (req, res) => {
  const result = await deleteAdminServiceRequest(req.params.jobId, req.user);
  return sendResponse(res, {
    message: "Admin service request deleted",
    data: result,
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

export const createAdminUserController = async (req, res) => {
  const result = await createAdminUserOrCompany(req.body, req.user);
  return sendResponse(res, {
    statusCode: 201,
    message: "Admin user created",
    data: result,
  });
};

export const adminUserByIdController = async (req, res) => {
  const result = await getAdminUserById(req.params.userId);
  return sendResponse(res, {
    message: "Admin user fetched",
    data: result,
  });
};

export const updateAdminUserController = async (req, res) => {
  const result = await updateAdminUser(req.params.userId, req.body, req.user);
  return sendResponse(res, {
    message: "Admin user updated",
    data: result,
  });
};

export const adminUserMembersController = async (req, res) => {
  const result = await listAdminUserMembers(req.params.userId);
  return sendResponse(res, {
    message: "Admin user members fetched",
    data: result,
  });
};

export const resetAdminUserPasswordController = async (req, res) => {
  const result = await resetAdminUserPassword(req.params.userId, req.body, req.user);
  return sendResponse(res, {
    message: "Admin user password reset",
    data: result,
  });
};

export const sendAdminUserMessageController = async (req, res) => {
  const result = await sendAdminUserMessage(req.params.userId, req.body, req.user);
  return sendResponse(res, {
    statusCode: 201,
    message: "Admin user message sent",
    data: result,
  });
};

export const deleteAdminUserController = async (req, res) => {
  const result = await deleteAdminUser(req.params.userId, req.user);
  return sendResponse(res, {
    message: "Admin user removed",
    data: result,
  });
};

export const adminFleetController = async (req, res) => {
  const result = await listAdminFleet(req.query);
  return sendResponse(res, {
    message: "Admin fleet fetched",
    data: result,
  });
};

export const createAdminFleetController = async (req, res) => {
  const result = await createAdminFleetCompany(req.body, req.user);
  return sendResponse(res, {
    statusCode: 201,
    message: "Admin fleet company created",
    data: result,
  });
};

export const updateAdminFleetController = async (req, res) => {
  const result = await updateAdminFleetCompany(req.params.fleetId, req.body, req.user);
  return sendResponse(res, {
    message: "Admin fleet company updated",
    data: result,
  });
};

export const deleteAdminFleetController = async (req, res) => {
  const result = await deleteAdminFleetCompany(req.params.fleetId, req.user);
  return sendResponse(res, {
    message: "Admin fleet company removed",
    data: result,
  });
};

export const createAdminFleetVehicleController = async (req, res) => {
  const result = await createAdminFleetVehicle(req.params.fleetId, req.body, req.user);
  return sendResponse(res, {
    statusCode: 201,
    message: "Admin fleet vehicle created",
    data: result,
  });
};

export const updateAdminFleetVehicleController = async (req, res) => {
  const result = await updateAdminFleetVehicle(
    req.params.fleetId,
    req.params.vehicleId,
    req.body,
    req.user
  );
  return sendResponse(res, {
    message: "Admin fleet vehicle updated",
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

export const createAdminFinancialInvoiceController = async (req, res) => {
  const result = await createAdminFinancialInvoice(req.body, req.user);
  return sendResponse(res, {
    statusCode: 201,
    message: "Admin invoice created",
    data: result,
  });
};

export const exportAdminFinancialController = async (req, res) => {
  const result = await exportAdminFinancialOverview(req.query);

  const format = `${req.query?.format || "CSV"}`.trim().toUpperCase();
  if (format === "CSV") {
    const escapeCsv = (value) => {
      if (value === null || value === undefined) return "";
      const raw = String(value);
      if (/[",\n\r]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
      return raw;
    };

    const rows = [
      ["Invoice No", "Company", "Service", "Amount", "Currency", "Payment Method", "Status", "Date"],
      ...(result.items || []).map((item) => [
        item.invoiceNo,
        item.company,
        item.service,
        item.amount,
        item.currency,
        item.paymentMethod,
        item.status,
        item.date,
      ]),
    ];

    const csv = rows.map((row) => row.map(escapeCsv).join(",")).join("\n");
    const filename = `financial-report-${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  }

  return sendResponse(res, {
    message: "Admin financial export prepared",
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

export const markAdminNotificationReadController = async (req, res) => {
  const result = await markAdminNotificationRead(req.params.notificationId, req.user);
  return sendResponse(res, {
    message: "Admin notification marked as read",
    data: result,
  });
};

export const markAllAdminNotificationsReadController = async (req, res) => {
  const result = await markAllAdminNotificationsRead(req.user);
  return sendResponse(res, {
    message: "Admin notifications marked as read",
    data: result,
  });
};

export const removeAdminNotificationController = async (req, res) => {
  const result = await removeAdminNotification(req.params.notificationId, req.user);
  return sendResponse(res, {
    message: "Admin notification deleted",
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

export const deleteAdminPromotionController = async (req, res) => {
  const result = await deleteAdminPromotion(req.params.promotionId);
  return sendResponse(res, {
    message: "Admin promotion deleted",
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

export const adminReviewByIdController = async (req, res) => {
  const result = await getAdminReviewById(req.params.reviewId);
  return sendResponse(res, {
    message: "Admin review fetched",
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

export const deleteAdminReviewController = async (req, res) => {
  const result = await deleteAdminReview(req.params.reviewId);
  return sendResponse(res, {
    message: "Admin review deleted",
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

export const exportAdminReportsController = async (req, res) => {
  const result = await exportAdminReports(req.query);
  const format = `${req.query?.format || "PDF"}`.trim().toUpperCase();

  // Production-ready export: CSV download for frontend.
  if (format === "CSV") {
    const escapeCsv = (value) => {
      if (value === null || value === undefined) return "";
      const raw = String(value);
      if (/[",\n\r]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
      return raw;
    };

    const report = result.report || {};
    const rows = [];
    rows.push(["Report Type", report.reportType || ""]);
    rows.push(["Generated At", new Date(result.generatedAt).toISOString()]);
    rows.push([]);

    // Summary
    rows.push(["Summary"]);
    rows.push(["Total Revenue", report.summary?.totalRevenue ?? 0]);
    rows.push(["Total Services", report.summary?.totalServices ?? 0]);
    rows.push(["Active Companies", report.summary?.activeCompanies ?? 0]);
    rows.push(["Avg Service Value", report.summary?.avgServiceValue ?? 0]);
    rows.push([]);

    // Monthly trend
    rows.push(["Monthly Revenue Trend"]);
    rows.push(["Month", "Revenue", "Services"]);
    for (const item of report.monthlyRevenueTrend || []) {
      rows.push([item.month, item.revenue, item.services]);
    }
    rows.push([]);

    // Top services
    rows.push(["Top Services"]);
    rows.push(["Service", "Count", "Revenue"]);
    for (const item of report.topServices || []) {
      rows.push([item.name, item.count, item.revenue]);
    }
    rows.push([]);

    // Top companies
    rows.push(["Top Companies"]);
    rows.push(["Company", "Services", "Revenue"]);
    for (const item of report.topCompanies || []) {
      rows.push([item.companyName, item.services, item.revenue]);
    }
    rows.push([]);

    // Mechanic performance
    rows.push(["Mechanic Performance"]);
    rows.push(["Mechanic", "Services", "Rating", "Revenue"]);
    for (const item of report.mechanicPerformance || []) {
      rows.push([item.mechanicName, item.services, item.rating, item.revenue]);
    }

    const csv = rows.map((row) => row.map(escapeCsv).join(",")).join("\n");
    const filename = `admin-report-${(report.reportType || "REPORT")
      .toString()
      .toLowerCase()
      .replace(/\s+/g, "-")}-${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  }

  return sendResponse(res, {
    message: "Admin report export prepared",
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

export const updateAdminSettingsController = async (req, res) => {
  const result = await updateAdminSettings(req.user, req.body);
  return sendResponse(res, {
    message: "Admin settings updated",
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
