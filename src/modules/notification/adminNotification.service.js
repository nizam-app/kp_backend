import { ROLES, USER_STATUS } from "../../constants/domain.js";
import { User } from "../user/user.model.js";
import { sendAdminAlertEmail } from "../email/email.service.js";
import { Notification } from "./notification.model.js";
import { createNotification } from "./notification.service.js";
import {
  ADMIN_NOTIFICATION_EVENTS,
  adminNotificationEventKeys,
  normalizeAdminNotificationPreferences,
} from "./adminNotificationEvents.js";

const normalizeEventKey = (value) => `${value || ""}`.trim().toUpperCase();

const deliverToAdmin = async (admin, event) => {
  const preferences = normalizeAdminNotificationPreferences(
    admin.adminSettings?.notificationPreferences,
    { securityAlertsEnabled: admin.adminSettings?.securityAlertsEnabled }
  );
  const channels = preferences[event.eventKey];
  if (!channels || !Object.values(channels).some(Boolean)) {
    return { adminId: admin._id, skipped: true };
  }
  if (event.dedupeKey) {
    const exists = await Notification.exists({
      user: admin._id,
      eventKey: event.eventKey,
      dedupeKey: event.dedupeKey,
    });
    if (exists) return { adminId: admin._id, skipped: true, duplicate: true };
  }

  const notification = await createNotification({
    user: admin._id,
    type: event.type || `ADMIN_${event.eventKey}`,
    eventKey: event.eventKey,
    ...(event.dedupeKey ? { dedupeKey: event.dedupeKey } : {}),
    title: event.title,
    body: event.body,
    data: event.data || {},
    channels,
    ...(channels.inApp ? {} : { isRead: true, readAt: new Date() }),
  });

  let emailStatus = "NOT_REQUESTED";
  let emailError;
  if (channels.email) {
    try {
      const emailResult = await sendAdminAlertEmail({
        to: admin.adminSettings?.billingEmail || admin.email,
        subject: event.emailSubject || event.title,
        title: event.title,
        body: event.emailBody || event.body,
      });
      emailStatus = emailResult.sent ? "SENT" : "SKIPPED";
      emailError = emailResult.sent ? undefined : emailResult.reason;
    } catch (error) {
      emailStatus = "FAILED";
      emailError = `${error?.message || error}`.slice(0, 500);
    }

    await Notification.findByIdAndUpdate(notification._id, {
      $set: {
        "delivery.emailStatus": emailStatus,
        "delivery.emailAttemptedAt": new Date(),
        ...(emailError ? { "delivery.emailError": emailError } : {}),
      },
    });
  }

  return {
    adminId: admin._id,
    notificationId: notification._id,
    channels,
    emailStatus,
  };
};

export const dispatchAdminNotificationEvent = async (payload = {}) => {
  const eventKey = normalizeEventKey(payload.eventKey);
  if (!adminNotificationEventKeys.includes(eventKey)) {
    throw new Error(`Unknown admin notification event: ${eventKey}`);
  }
  if (!payload.title || !payload.body) {
    throw new Error("Admin notification title and body are required");
  }

  const admins = await User.find({
    role: ROLES.ADMIN,
    status: USER_STATUS.ACTIVE,
  })
    .select("_id email adminSettings")
    .lean();

  const settled = await Promise.allSettled(
    admins.map((admin) =>
      deliverToAdmin(admin, {
        ...payload,
        eventKey,
      })
    )
  );
  const failed = settled.filter((result) => result.status === "rejected");
  if (failed.length) {
    console.error(
      `[admin-notifications] ${eventKey}: ${failed.length}/${admins.length} deliveries failed`
    );
  }
  return {
    eventKey,
    recipients: admins.length,
    delivered: settled.length - failed.length,
    failed: failed.length,
  };
};

export const notifyAdminsSafely = async (payload) => {
  try {
    return await dispatchAdminNotificationEvent(payload);
  } catch (error) {
    console.error(
      `[admin-notifications] ${payload?.eventKey || "UNKNOWN"}:`,
      error?.message || error
    );
    return { failed: true };
  }
};

export const reportSystemHealthAlert = async ({ title, body, data } = {}) =>
  notifyAdminsSafely({
    eventKey: ADMIN_NOTIFICATION_EVENTS.SYSTEM_HEALTH,
    title: title || "TruckFix system health alert",
    body: body || "A monitored service reported an unhealthy state.",
    data: data || {},
  });
