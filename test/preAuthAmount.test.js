import test from "node:test";
import assert from "node:assert/strict";

import AppError from "../src/utils/AppError.js";
import {
  PRE_AUTH_AMOUNT_MAX,
  assertValidOptionalPreAuthAmount,
  normalizePreAuthAmountInput,
  serializePreAuthAmount,
} from "../src/utils/preAuthAmount.js";

const expectInvalid = (value) => {
  assert.throws(
    () => assertValidOptionalPreAuthAmount(value),
    (err) =>
      err instanceof AppError &&
      err.statusCode === 400 &&
      err.data?.code === "INVALID_PRE_AUTH_AMOUNT"
  );
};

test("assertValidOptionalPreAuthAmount: omitted / null / undefined → not set", () => {
  assert.equal(assertValidOptionalPreAuthAmount(undefined), undefined);
  assert.equal(assertValidOptionalPreAuthAmount(null), undefined);
});

test("assertValidOptionalPreAuthAmount: valid integer stored as number", () => {
  assert.equal(assertValidOptionalPreAuthAmount(500), 500);
});

test("assertValidOptionalPreAuthAmount: valid decimal rounded to 2dp", () => {
  assert.equal(assertValidOptionalPreAuthAmount(500.255), 500.26);
  assert.equal(assertValidOptionalPreAuthAmount(99.9), 99.9);
  assert.equal(assertValidOptionalPreAuthAmount("12.34"), 12.34);
});

test("assertValidOptionalPreAuthAmount: numeric string accepted", () => {
  assert.equal(assertValidOptionalPreAuthAmount("500"), 500);
  assert.equal(assertValidOptionalPreAuthAmount("500.25"), 500.25);
});

test("assertValidOptionalPreAuthAmount: rejects zero, negative, empty, non-numeric", () => {
  expectInvalid(0);
  expectInvalid(-1);
  expectInvalid(-0.01);
  expectInvalid("");
  expectInvalid("   ");
  expectInvalid("abc");
  expectInvalid("12abc");
  expectInvalid(true);
  expectInvalid({});
  expectInvalid([]);
});

test("assertValidOptionalPreAuthAmount: rejects NaN and Infinity", () => {
  expectInvalid(NaN);
  expectInvalid(Infinity);
  expectInvalid(-Infinity);
});

test("assertValidOptionalPreAuthAmount: rejects above PRE_AUTH_AMOUNT_MAX", () => {
  expectInvalid(PRE_AUTH_AMOUNT_MAX + 0.01);
  expectInvalid(PRE_AUTH_AMOUNT_MAX + 1);
  assert.equal(assertValidOptionalPreAuthAmount(PRE_AUTH_AMOUNT_MAX), PRE_AUTH_AMOUNT_MAX);
});

test("assertValidOptionalPreAuthAmount: rejects values that round to zero", () => {
  expectInvalid(0.001);
  expectInvalid(0.004);
  assert.equal(assertValidOptionalPreAuthAmount(0.005), 0.01);
  assert.equal(assertValidOptionalPreAuthAmount(0.01), 0.01);
});

test("normalizePreAuthAmountInput: multipart string coercion", () => {
  assert.equal(normalizePreAuthAmountInput("500"), 500);
  assert.equal(normalizePreAuthAmountInput("500.25"), 500.25);
  assert.equal(normalizePreAuthAmountInput(""), "");
  assert.equal(normalizePreAuthAmountInput("   "), "");
  assert.equal(normalizePreAuthAmountInput("nope"), "nope");
  assert.equal(normalizePreAuthAmountInput(null), null);
  assert.equal(normalizePreAuthAmountInput(undefined), undefined);
  assert.equal(normalizePreAuthAmountInput(["500.5"]), 500.5);
});

test("serializePreAuthAmount: null for missing, number when present", () => {
  assert.equal(serializePreAuthAmount({}), null);
  assert.equal(serializePreAuthAmount({ preAuthAmount: undefined }), null);
  assert.equal(serializePreAuthAmount({ preAuthAmount: null }), null);
  assert.equal(serializePreAuthAmount({ preAuthAmount: 250 }), 250);
  assert.equal(serializePreAuthAmount({ estimatedPayout: 999 }), null);
  assert.equal(serializePreAuthAmount({ acceptedAmount: 100, finalAmount: 200 }), null);
});

test("PRE_AUTH_AMOUNT_MAX is 1_000_000", () => {
  assert.equal(PRE_AUTH_AMOUNT_MAX, 1_000_000);
});

/**
 * Pure eligibility mirror of updateJob Pre-Auth branch (POSTED already enforced
 * by assertPostedFleetJob → 400 JOB_NOT_EDITABLE before this check).
 */
const assertPreAuthUnlocked = (quoteExists) => {
  if (quoteExists) {
    throw new AppError(
      "Pre-Auth Budget is locked because a quote has been submitted",
      409,
      { code: "PRE_AUTH_LOCKED" }
    );
  }
};

test("lock rule: quoteExists → 409 PRE_AUTH_LOCKED", () => {
  assert.throws(
    () => assertPreAuthUnlocked(true),
    (err) =>
      err instanceof AppError &&
      err.statusCode === 409 &&
      err.data?.code === "PRE_AUTH_LOCKED" &&
      /locked because a quote has been submitted/i.test(err.message)
  );
  assert.doesNotThrow(() => assertPreAuthUnlocked(false));
  assert.doesNotThrow(() => assertPreAuthUnlocked(null));
});

test("update clear vs set semantics for own-property payload", () => {
  const clearPayload = { preAuthAmount: null };
  assert.equal(Object.prototype.hasOwnProperty.call(clearPayload, "preAuthAmount"), true);
  assert.equal(clearPayload.preAuthAmount, null);

  const omitPayload = { title: "x" };
  assert.equal(Object.prototype.hasOwnProperty.call(omitPayload, "preAuthAmount"), false);

  const setPayload = { preAuthAmount: 100 };
  assert.equal(assertValidOptionalPreAuthAmount(setPayload.preAuthAmount), 100);
});
