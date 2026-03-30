import AppError from "../../utils/AppError.js";
import { Notification } from "./notification.model.js";
import { DeviceToken } from "./deviceToken.model.js";

const parsePage = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
};

const parseLimit = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(Math.floor(n), 100);
};

const serializeNotification = (notification) => ({
  _id: notification._id,
  type: notification.type,
  title: notification.title,
  body: notification.body,
  data: notification.data || null,
  isRead: notification.isRead,
  readAt: notification.readAt || null,
  createdAt: notification.createdAt,
});

const serializeDeviceToken = (token) => ({
  _id: token._id,
  token: token.token,
  platform: token.platform,
  appVersion: token.appVersion || null,
  isActive: token.isActive,
  lastSeenAt: token.lastSeenAt,
  createdAt: token.createdAt,
  updatedAt: token.updatedAt,
});

export const listNotifications = async (user, query = {}) => {
  const page = parsePage(query.page);
  const limit = parseLimit(query.limit);
  const skip = (page - 1) * limit;

  const filter = { user: user._id };
  if (`${query.unreadOnly}` === "true") filter.isRead = false;

  const [items, total, unreadCount] = await Promise.all([
    Notification.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Notification.countDocuments(filter),
    Notification.countDocuments({ user: user._id, isRead: false }),
  ]);

  return {
    items: items.map(serializeNotification),
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
      unreadCount,
    },
  };
};

export const markNotificationRead = async (user, notificationId) => {
  const notification = await Notification.findOne({
    _id: notificationId,
    user: user._id,
  });
  if (!notification) throw new AppError("Notification not found", 404);

  notification.isRead = true;
  notification.readAt = new Date();
  await notification.save({ validateBeforeSave: false });

  return serializeNotification(notification);
};

export const registerDeviceToken = async (user, payload = {}) => {
  const tokenValue = `${payload.token || ""}`.trim();
  const platform = `${payload.platform || ""}`.trim();

  if (!tokenValue) throw new AppError("token is required", 400);
  if (!["ios", "android", "web"].includes(platform)) {
    throw new AppError("platform must be ios, android, or web", 400);
  }

  const existing = await DeviceToken.findOne({ token: tokenValue });
  if (existing) {
    existing.user = user._id;
    existing.platform = platform;
    existing.appVersion = payload.appVersion || existing.appVersion;
    existing.isActive = true;
    existing.lastSeenAt = new Date();
    await existing.save({ validateBeforeSave: false });
    return serializeDeviceToken(existing);
  }

  const created = await DeviceToken.create({
    user: user._id,
    token: tokenValue,
    platform,
    appVersion: payload.appVersion,
    isActive: true,
    lastSeenAt: new Date(),
  });

  return serializeDeviceToken(created);
};

export const listDeviceTokens = async (user) => {
  const items = await DeviceToken.find({ user: user._id, isActive: true })
    .sort({ updatedAt: -1 })
    .lean();
  return items.map(serializeDeviceToken);
};
