import test from "node:test";
import assert from "node:assert/strict";

import {
  invoiceStatusFromPaymentIntent,
  shouldSkipDowngrade,
  isWebhookTimestampExpired,
  TERMINAL_PAID_STATUSES,
} from "../src/modules/billing/stripePaymentStatus.js";

test("succeeded intent marks the invoice paid", () => {
  const mapped = invoiceStatusFromPaymentIntent("succeeded");
  assert.equal(mapped.invoiceStatus, "PAID");
  assert.equal(mapped.paymentStatus, "SUCCEEDED");
  assert.equal(mapped.markPaid, true);
});

test("requires_action keeps the invoice unpaid pending authentication", () => {
  const mapped = invoiceStatusFromPaymentIntent("requires_action");
  assert.equal(mapped.markPaid, false);
  assert.equal(mapped.paymentStatus, "REQUIRES_ACTION");
});

test("unknown status falls back to a safe pending state", () => {
  const mapped = invoiceStatusFromPaymentIntent("something_new");
  assert.equal(mapped.markPaid, false);
  assert.equal(mapped.paymentStatus, "PENDING");
});

test("a confirmed payment is never downgraded by a stale event", () => {
  const stale = invoiceStatusFromPaymentIntent("processing");
  assert.equal(shouldSkipDowngrade("SUCCEEDED", stale), true);
});

test("a paid event is still applied over a confirmed payment (idempotent)", () => {
  const paid = invoiceStatusFromPaymentIntent("succeeded");
  assert.equal(shouldSkipDowngrade("SUCCEEDED", paid), false);
});

test("terminal paid statuses only include SUCCEEDED", () => {
  assert.deepEqual([...TERMINAL_PAID_STATUSES], ["SUCCEEDED"]);
});

test("webhook timestamp inside tolerance is accepted", () => {
  const now = 1_700_000_000;
  assert.equal(isWebhookTimestampExpired(now - 60, now, 300), false);
});

test("webhook timestamp outside tolerance is rejected (replay protection)", () => {
  const now = 1_700_000_000;
  assert.equal(isWebhookTimestampExpired(now - 3600, now, 300), true);
});
