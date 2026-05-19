import { sendResponse } from "../../utils/sendResponse.js";
import {
  getNotificationById,
  listDeviceTokens,
  listNotifications,
  markNotificationRead,
  registerDeviceToken,
} from "./notification.service.js";

export const listNotificationsController = async (req, res) => {
  const result = await listNotifications(req.user, req.query);
  return sendResponse(res, {
    message: "Notifications fetched",
    data: result.items,
    meta: result.meta,
  });
};

export const getNotificationController = async (req, res) => {
  const notification = await getNotificationById(req.user, req.params.id);
  return sendResponse(res, {
    message: "Notification fetched",
    data: notification,
  });
};

export const markNotificationReadController = async (req, res) => {
  const notification = await markNotificationRead(req.user, req.params.id);
  return sendResponse(res, {
    message: "Notification marked as read",
    data: notification,
  });
};

export const registerDeviceTokenController = async (req, res) => {
  const token = await registerDeviceToken(req.user, req.body);
  return sendResponse(res, {
    statusCode: 201,
    message: "Device token saved",
    data: token,
  });
};

export const listDeviceTokensController = async (req, res) => {
  const items = await listDeviceTokens(req.user);
  return sendResponse(res, {
    message: "Device tokens fetched",
    data: items,
  });
};
