import fs from "fs";
import path from "path";
import admin from "firebase-admin";
import { env } from "../../config/env.js";
import { ROLES } from "../../constants/domain.js";
import { User } from "../user/user.model.js";
import { DeviceToken } from "./deviceToken.model.js";
import {
  buildNotificationNavigation,
  flattenNavigationForPush,
} from "./notificationNavigation.util.js";

/** Maps in-app notification `type` to `user.preferences.notifications` key (mechanic / fleet / company). */
const NOTIFICATION_TYPE_TO_PREFERENCE_KEY = {
  CHAT_MESSAGE: "appAlerts",
  REVIEW_CREATED: "appAlerts",
  QUOTE_RECEIVED: "appAlerts",
  QUOTE_ACCEPTED: "appAlerts",
  QUOTE_DECLINED: "appAlerts",
  QUOTE_UPDATED: "appAlerts",
  QUOTE_WITHDRAWN: "appAlerts",
  QUOTE_NOT_SELECTED: "appAlerts",
  JOB_ASSIGNED: "appAlerts",
  JOB_MECHANIC_REASSIGNED: "appAlerts",
  JOB_STATUS_EN_ROUTE: "appAlerts",
  JOB_STATUS_ON_SITE: "appAlerts",
  JOB_STATUS_IN_PROGRESS: "appAlerts",
  JOB_AWAITING_APPROVAL: "appAlerts",
  JOB_COMPLETED: "appAlerts",
  JOB_CANCELLED: "appAlerts",
  DISPUTE_CREATED: "systemAlerts",
  DISPUTE_UPDATED: "systemAlerts",
  SUPPORT_TICKET_CREATED: "systemAlerts",
  SUPPORT_TICKET_UPDATED: "systemAlerts",
  SUPPORT_TICKET_REPLY: "systemAlerts",
  ADMIN_DIRECT_MESSAGE: "systemAlerts",
};

const INVALID_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

let initAttempted = false;
let firebaseReady = false;

export const isPushConfigured = () =>
  Boolean(
    (env.FIREBASE_SERVICE_ACCOUNT_PATH || "").trim() ||
      (env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim()
  );

function tryInitFirebase() {
  if (initAttempted) return firebaseReady;
  initAttempted = true;
  if (!isPushConfigured()) return false;
  try {
    if (admin.apps.length > 0) {
      firebaseReady = true;
      return true;
    }
    const jsonRaw = (env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();
    if (jsonRaw) {
      const cred = JSON.parse(jsonRaw);
      admin.initializeApp({ credential: admin.credential.cert(cred) });
      firebaseReady = true;
      return true;
    }
    const rel = (env.FIREBASE_SERVICE_ACCOUNT_PATH || "").trim();
    if (rel) {
      const abs = path.isAbsolute(rel) ? rel : path.resolve(process.cwd(), rel);
      const cred = JSON.parse(fs.readFileSync(abs, "utf8"));
      admin.initializeApp({ credential: admin.credential.cert(cred) });
      firebaseReady = true;
      return true;
    }
  } catch (e) {
    console.error("[push] Firebase Admin init failed:", e?.message || e);
  }
  firebaseReady = false;
  return false;
}

export function shouldSendPushToUser(user, notificationType) {
  if (!user) return false;
  if (user.role === ROLES.ADMIN) {
    if (user.adminSettings?.notificationsEnabled === false) return false;
    return true;
  }
  if (user.preferences?.pushEnabled === false) return false;
  const key =
    NOTIFICATION_TYPE_TO_PREFERENCE_KEY[notificationType] || "appAlerts";
  const prefs = user.preferences?.notifications || {};
  if (prefs[key] === false) return false;
  return true;
}

const stringifyData = (data) => {
  if (!data || typeof data !== "object") return {};
  return Object.fromEntries(
    Object.entries(data).map(([k, v]) => [
      k,
      v === null || v === undefined ? "" : String(v),
    ])
  );
};

const truncate = (s, max) => {
  const t = `${s || ""}`;
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
};

/**
 * Sends FCM data + notification payload to all active device tokens for the recipient.
 * No-ops when Firebase env is not configured. Swallows errors after logging.
 *
 * @param {import("mongoose").Document} notification — persisted Notification doc
 */
export async function sendPushForPersistedNotification(notification) {
  if (!isPushConfigured() || !tryInitFirebase()) return;

  const userId = notification.user?._id || notification.user;
  if (!userId) return;

  const user = await User.findById(userId)
    .select("role preferences adminSettings")
    .lean();

  if (!shouldSendPushToUser(user, notification.type)) return;

  const tokenDocs = await DeviceToken.find({ user: userId, isActive: true })
    .select("token")
    .lean();

  if (!tokenDocs.length) return;

  const nav = buildNotificationNavigation(
    notification.type,
    notification.data
  );
  const baseData = {
    notificationId: notification._id.toString(),
    type: notification.type,
    ...flattenNavigationForPush(nav),
    ...(typeof notification.data === "object" && notification.data
      ? notification.data
      : {}),
  };
  const data = stringifyData(baseData);

  const title = truncate(notification.title, 200);
  const body = truncate(notification.body, 1000);

  const messages = tokenDocs.map((doc) => ({
    token: doc.token,
    notification: { title, body },
    data,
    android: { priority: "high" },
    apns: {
      headers: { "apns-priority": "10" },
      payload: { aps: { sound: "default" } },
    },
  }));

  const FCM_BATCH = 500;
  const deactivate = [];

  try {
    for (let offset = 0; offset < messages.length; offset += FCM_BATCH) {
      const slice = messages.slice(offset, offset + FCM_BATCH);
      const batch = await admin.messaging().sendEach(slice);
      batch.responses.forEach((res, j) => {
        if (res.success) return;
        const code = res.error?.code || res.error?.errorInfo?.code;
        if (code && INVALID_TOKEN_CODES.has(code)) {
          const doc = tokenDocs[offset + j];
          if (doc?.token) deactivate.push(doc.token);
        }
      });
    }
    if (deactivate.length) {
      await DeviceToken.updateMany(
        { token: { $in: [...new Set(deactivate)] } },
        { $set: { isActive: false } }
      );
    }
  } catch (e) {
    console.error("[push] FCM sendEach failed:", e?.message || e);
  }
}
