import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import { User } from "../src/modules/user/user.model.js";
import { StripeWebhookEvent } from "../src/modules/billing/stripeWebhookEvent.model.js";
import {
  payoutReconciliationResult,
  processStripeWebhookEvent,
  refundReconciliationState,
} from "../src/modules/billing/stripeWebhook.service.js";
import {
  stripeConnectStatusFields,
  syncStripeConnectAccountFromWebhook,
} from "../src/modules/billing/stripe.service.js";
import {
  stripePaymentAttemptIdempotencyKey,
  stripePaymentIdempotencyKeyForJob,
} from "../src/modules/billing/paymentAttempt.model.js";
import {
  invoiceStatusFromPaymentIntent,
  shouldSkipDowngrade,
} from "../src/modules/billing/stripePaymentStatus.js";

test("Connect status synchronizes mechanics and companies including transfers", async () => {
  const originalFindOne = User.findOne;
  const originalUpdateOne = User.updateOne;
  const updates = [];
  let currentUser;
  User.findOne = () => ({ select: async () => currentUser });
  User.updateOne = async (filter, update) => {
    updates.push({ filter, update });
    return { acknowledged: true };
  };

  const account = {
    id: "acct_ready",
    details_submitted: true,
    charges_enabled: true,
    payouts_enabled: true,
    capabilities: { transfers: "active" },
  };

  try {
    for (const role of ["MECHANIC", "COMPANY"]) {
      currentUser = { _id: new mongoose.Types.ObjectId(), role };
      const result = await syncStripeConnectAccountFromWebhook(account);
      assert.equal(result.role, role);
      assert.equal(result.onboardingComplete, true);
      assert.equal(result.transfersEnabled, true);
    }
  } finally {
    User.findOne = originalFindOne;
    User.updateOne = originalUpdateOne;
  }

  assert.equal(updates.length, 2);
  assert.equal(
    updates[0].update.$set[
      "mechanicProfile.stripeConnectTransfersEnabled"
    ],
    true
  );
  assert.equal(
    updates[1].update.$set["companyProfile.stripeConnectTransfersEnabled"],
    true
  );
});

test("incomplete Connect onboarding remains payout-ineligible", () => {
  const fields = stripeConnectStatusFields({
    details_submitted: true,
    charges_enabled: true,
    payouts_enabled: true,
    capabilities: { transfers: "pending" },
  });
  assert.equal(fields.stripeConnectOnboardingComplete, false);
  assert.equal(fields.stripeConnectTransfersEnabled, false);
});

test("payment keys keep a job guard while separating terminal attempts", () => {
  const jobId = new mongoose.Types.ObjectId();
  const jobKey = stripePaymentIdempotencyKeyForJob(jobId);
  const firstAttemptKey = stripePaymentAttemptIdempotencyKey(jobId, "attempt_first");
  const repeatedFirstAttemptKey = stripePaymentAttemptIdempotencyKey(
    jobId,
    "attempt_first"
  );
  const secondAttemptKey = stripePaymentAttemptIdempotencyKey(
    jobId,
    "attempt_second"
  );

  assert.equal(jobKey, `job:${jobId}:payment`);
  assert.equal(firstAttemptKey, repeatedFirstAttemptKey);
  assert.notEqual(firstAttemptKey, secondAttemptKey);
  assert.match(firstAttemptKey, new RegExp(`^${jobKey}:attempt:`));
});

test("3DS completion is paid only after Stripe reports succeeded", () => {
  const redirectState = invoiceStatusFromPaymentIntent("requires_action");
  assert.equal(redirectState.markPaid, false);
  assert.equal(redirectState.invoiceStatus, "ISSUED");

  const webhookState = invoiceStatusFromPaymentIntent("succeeded");
  assert.equal(webhookState.markPaid, true);
  assert.equal(webhookState.invoiceStatus, "PAID");
  assert.equal(shouldSkipDowngrade("SUCCEEDED", redirectState), true);
});

test("duplicate webhook delivery is processed once", async () => {
  const originalCreate = StripeWebhookEvent.create;
  const originalUpdateOne = StripeWebhookEvent.updateOne;
  const originalDeleteOne = StripeWebhookEvent.deleteOne;
  const claimed = new Set();
  let completed = 0;

  StripeWebhookEvent.create = async ({ eventId }) => {
    if (claimed.has(eventId)) {
      const error = new Error("duplicate");
      error.code = 11000;
      throw error;
    }
    claimed.add(eventId);
  };
  StripeWebhookEvent.updateOne = async () => {
    completed += 1;
  };
  StripeWebhookEvent.deleteOne = async ({ eventId }) => {
    claimed.delete(eventId);
  };

  const event = {
    id: "evt_duplicate",
    type: "test.unhandled",
    data: { object: { id: "obj_1" } },
  };

  try {
    const first = await processStripeWebhookEvent(event);
    const duplicate = await processStripeWebhookEvent(event);
    assert.equal(first.reason, "event_not_handled");
    assert.equal(duplicate.reason, "duplicate_event");
    assert.equal(completed, 1);
  } finally {
    StripeWebhookEvent.create = originalCreate;
    StripeWebhookEvent.updateOne = originalUpdateOne;
    StripeWebhookEvent.deleteOne = originalDeleteOne;
  }
});

test("refund reconciliation records refund state without an unpaid state", () => {
  const partial = refundReconciliationState(120, 20);
  assert.equal(partial.invoiceStatus, "PARTIALLY_REFUNDED");
  assert.equal(partial.paymentStatus, "PARTIALLY_REFUNDED");

  const full = refundReconciliationState(120, 120);
  assert.equal(full.invoiceStatus, "REFUNDED");
  assert.equal(full.paymentStatus, "REFUNDED");
  assert.notEqual(full.paymentStatus, "FAILED");
});

test("failed payout reconciliation records failure without payment downgrade", () => {
  const payment = { status: "SUCCEEDED" };
  const result = payoutReconciliationResult(
    {
      id: "po_failed",
      status: "failed",
      failure_code: "account_closed",
      failure_message: "Bank account closed",
    },
    "payout.failed",
    "acct_company",
    { _id: new mongoose.Types.ObjectId(), role: "COMPANY" }
  );

  assert.equal(result.payoutStatus, "FAILED");
  assert.equal(result.failureCode, "account_closed");
  assert.equal(payment.status, "SUCCEEDED");
});
