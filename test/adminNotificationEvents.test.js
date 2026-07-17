import test from "node:test";
import assert from "node:assert/strict";

import {
  ADMIN_NOTIFICATION_EVENTS,
  adminNotificationEventKeys,
  normalizeAdminNotificationPreferences,
} from "../src/modules/notification/adminNotificationEvents.js";

test("admin notification defaults cover all six product events", () => {
  assert.equal(adminNotificationEventKeys.length, 6);
  const preferences = normalizeAdminNotificationPreferences();
  assert.deepEqual(Object.keys(preferences), adminNotificationEventKeys);
  for (const channels of Object.values(preferences)) {
    assert.equal(typeof channels.push, "boolean");
    assert.equal(typeof channels.email, "boolean");
    assert.equal(typeof channels.inApp, "boolean");
  }
});

test("partial channel updates preserve defaults for omitted channels", () => {
  const preferences = normalizeAdminNotificationPreferences({
    [ADMIN_NOTIFICATION_EVENTS.JOB_POSTED]: { email: true },
  });
  assert.deepEqual(preferences.JOB_POSTED, {
    push: true,
    email: true,
    inApp: true,
  });
});

test("legacy security flag maps to system-health push preference", () => {
  const preferences = normalizeAdminNotificationPreferences(
    {},
    { securityAlertsEnabled: false }
  );
  assert.equal(preferences.SYSTEM_HEALTH.push, false);
  assert.equal(preferences.SYSTEM_HEALTH.email, true);
});

test("explicit system-health preference wins over legacy flag", () => {
  const preferences = normalizeAdminNotificationPreferences(
    { SYSTEM_HEALTH: { push: true, email: false, inApp: false } },
    { securityAlertsEnabled: false }
  );
  assert.deepEqual(preferences.SYSTEM_HEALTH, {
    push: true,
    email: false,
    inApp: false,
  });
});
