export const ADMIN_NOTIFICATION_EVENTS = Object.freeze({
  JOB_POSTED: "JOB_POSTED",
  DISPUTE_OPENED: "DISPUTE_OPENED",
  DISPUTE_MESSAGE: "DISPUTE_MESSAGE",
  PAYMENT_FAILED: "PAYMENT_FAILED",
  MECHANIC_REGISTERED: "MECHANIC_REGISTERED",
  SYSTEM_HEALTH: "SYSTEM_HEALTH",
  WEEKLY_DIGEST: "WEEKLY_DIGEST",
});

export const adminNotificationEventKeys = Object.freeze(
  Object.values(ADMIN_NOTIFICATION_EVENTS)
);

export const ADMIN_NOTIFICATION_CHANNELS = Object.freeze([
  "push",
  "email",
  "inApp",
]);

export const DEFAULT_ADMIN_NOTIFICATION_PREFERENCES = Object.freeze({
  [ADMIN_NOTIFICATION_EVENTS.JOB_POSTED]: {
    push: true,
    email: false,
    inApp: true,
  },
  [ADMIN_NOTIFICATION_EVENTS.DISPUTE_OPENED]: {
    push: true,
    email: true,
    inApp: true,
  },
  [ADMIN_NOTIFICATION_EVENTS.DISPUTE_MESSAGE]: {
    push: true,
    email: false,
    inApp: true,
  },
  [ADMIN_NOTIFICATION_EVENTS.PAYMENT_FAILED]: {
    push: true,
    email: true,
    inApp: true,
  },
  [ADMIN_NOTIFICATION_EVENTS.MECHANIC_REGISTERED]: {
    push: true,
    email: false,
    inApp: true,
  },
  [ADMIN_NOTIFICATION_EVENTS.SYSTEM_HEALTH]: {
    push: true,
    email: true,
    inApp: true,
  },
  [ADMIN_NOTIFICATION_EVENTS.WEEKLY_DIGEST]: {
    push: false,
    email: true,
    inApp: false,
  },
});

export const normalizeAdminNotificationPreferences = (
  raw = {},
  { securityAlertsEnabled } = {}
) =>
  Object.fromEntries(
    adminNotificationEventKeys.map((eventKey) => {
      const defaults = DEFAULT_ADMIN_NOTIFICATION_PREFERENCES[eventKey];
      const incoming =
        raw?.[eventKey] && typeof raw[eventKey] === "object" ? raw[eventKey] : {};
      const channels = Object.fromEntries(
        ADMIN_NOTIFICATION_CHANNELS.map((channel) => [
          channel,
          incoming[channel] === undefined
            ? defaults[channel]
            : Boolean(incoming[channel]),
        ])
      );
      if (
        eventKey === ADMIN_NOTIFICATION_EVENTS.SYSTEM_HEALTH &&
        incoming.push === undefined &&
        securityAlertsEnabled !== undefined
      ) {
        channels.push = Boolean(securityAlertsEnabled);
      }
      return [eventKey, channels];
    })
  );
