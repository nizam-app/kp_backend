import test from "node:test";
import assert from "node:assert/strict";

import {
  stripePaymentAttemptIdempotencyKey,
  stripePaymentConfirmationIdempotencyKey,
} from "../src/modules/billing/paymentAttempt.model.js";
import {
  buildPaymentAttemptUpsert,
  planStripePaymentIntentRetry,
} from "../src/modules/billing/paymentAttempt.service.js";

const attempt = (overrides = {}) => ({
  _id: "attempt-document",
  attemptId: "attempt_12345678",
  stripePaymentIntentId: "pi_123",
  stripePaymentMethodId: "pm_first",
  events: [],
  ...overrides,
});

test("PaymentAttempt upsert writes each MongoDB path through one operator", () => {
  const update = buildPaymentAttemptUpsert({
    job: "job_123",
    payer: "user_123",
    payerRole: "FLEET",
    amount: 120,
    currency: "GBP",
    paymentIntent: { id: "pi_123", status: "requires_payment_method" },
    paymentMethodId: "pm_first",
    attemptId: "attempt_12345678",
    createIdempotencyKey: "create_key",
    operationIdempotencyKey: "confirm_key",
    approvalRequestId: "request_12345678",
    paymentStatus: "REQUIRES_PAYMENT_METHOD",
    paid: false,
    eventType: "PAYMENT_INTENT_RECONFIRMED",
  });

  const setPaths = new Set(Object.keys(update.$set));
  const insertPaths = Object.keys(update.$setOnInsert);
  assert.deepEqual(insertPaths.filter((path) => setPaths.has(path)), []);
  assert.equal(update.$set.stripePaymentMethodId, "pm_first");
  assert.equal(update.$setOnInsert.stripePaymentMethodId, undefined);
  assert.deepEqual(update.$unset, {
    declineCode: 1,
    failureMessage: 1,
  });
  assert.equal(update.$push.events.externalEventId, "request_12345678");
  assert.equal(update.$push.events.idempotencyKey, "confirm_key");
});

test("retrying the same card with the same approval request reuses its result", () => {
  const existing = attempt({
    events: [
      {
        source: "APPROVAL",
        externalEventId: "request_12345678",
      },
    ],
  });
  assert.equal(
    planStripePaymentIntentRetry({
      paymentIntent: {
        id: "pi_123",
        status: "requires_payment_method",
        payment_method: "pm_first",
      },
      existingAttempt: existing,
      paymentMethodId: "pm_first",
      approvalRequestId: "request_12345678",
    }),
    "RETURN_EXISTING"
  );
});

test("reusing an approval request with another card is a conflict", () => {
  const existing = attempt({
    events: [
      {
        source: "APPROVAL",
        externalEventId: "request_12345678",
        stripePaymentMethodId: "pm_first",
      },
    ],
  });
  assert.equal(
    planStripePaymentIntentRetry({
      paymentIntent: {
        id: "pi_123",
        status: "requires_payment_method",
        payment_method: "pm_first",
      },
      existingAttempt: existing,
      paymentMethodId: "pm_second",
      approvalRequestId: "request_12345678",
    }),
    "REQUEST_CONFLICT"
  );
});

test("changing cards after a failed attempt confirms the reusable intent", () => {
  assert.equal(
    planStripePaymentIntentRetry({
      paymentIntent: {
        id: "pi_123",
        status: "requires_payment_method",
        payment_method: "pm_first",
      },
      existingAttempt: attempt(),
      paymentMethodId: "pm_second",
      approvalRequestId: "request_87654321",
    }),
    "CONFIRM_EXISTING"
  );
});

test("changed Stripe amount replaces a safely cancelable failed intent", () => {
  assert.equal(
    planStripePaymentIntentRetry({
      paymentIntent: {
        id: "pi_123",
        status: "requires_payment_method",
        payment_method: "pm_first",
        amount: 10_000,
        currency: "gbp",
      },
      existingAttempt: attempt(),
      paymentMethodId: "pm_first",
      approvalRequestId: "request_87654321",
      amountMinor: 12_000,
      currency: "GBP",
    }),
    "CANCEL_THEN_CREATE"
  );
});

test("changing cards cannot leave two chargeable 3DS intents", () => {
  assert.equal(
    planStripePaymentIntentRetry({
      paymentIntent: {
        id: "pi_123",
        status: "requires_action",
        payment_method: "pm_first",
      },
      existingAttempt: attempt(),
      paymentMethodId: "pm_second",
      approvalRequestId: "request_87654321",
    }),
    "CANCEL_THEN_CREATE"
  );
});

test("double-click requests use the same Stripe idempotency keys", () => {
  const createFirst = stripePaymentAttemptIdempotencyKey(
    "job_123",
    "request_12345678"
  );
  const createSecond = stripePaymentAttemptIdempotencyKey(
    "job_123",
    "request_12345678"
  );
  const confirmFirst = stripePaymentConfirmationIdempotencyKey(
    "job_123",
    "attempt_12345678",
    "request_12345678"
  );
  const confirmSecond = stripePaymentConfirmationIdempotencyKey(
    "job_123",
    "attempt_12345678",
    "request_12345678"
  );
  assert.equal(createFirst, createSecond);
  assert.equal(confirmFirst, confirmSecond);
});

test("a succeeded intent is reused and can never start another payment", () => {
  assert.equal(
    planStripePaymentIntentRetry({
      paymentIntent: {
        id: "pi_paid",
        status: "succeeded",
        payment_method: "pm_first",
      },
      existingAttempt: attempt({ paymentStatus: "SUCCEEDED" }),
      paymentMethodId: "pm_second",
      approvalRequestId: "request_87654321",
    }),
    "RETURN_EXISTING"
  );
});

test("existing 3DS intent is returned for client-side authentication", () => {
  assert.equal(
    planStripePaymentIntentRetry({
      paymentIntent: {
        id: "pi_3ds",
        status: "requires_action",
        payment_method: "pm_first",
      },
      existingAttempt: attempt(),
      paymentMethodId: "pm_first",
      approvalRequestId: "request_87654321",
    }),
    "RETURN_EXISTING"
  );
});
