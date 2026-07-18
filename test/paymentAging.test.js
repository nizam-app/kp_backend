import test from "node:test";
import assert from "node:assert/strict";
import { paymentAgingBucket } from "../src/modules/billing/paymentOperations.service.js";

const now = new Date("2026-07-18T12:00:00.000Z");

test("payment aging uses operational buckets", () => {
  assert.equal(
    paymentAgingBucket(new Date(now.getTime() - 12 * 60 * 60 * 1000), now),
    "0_1_DAYS"
  );
  assert.equal(
    paymentAgingBucket(new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000), now),
    "2_7_DAYS"
  );
  assert.equal(
    paymentAgingBucket(new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000), now),
    "15_30_DAYS"
  );
  assert.equal(
    paymentAgingBucket(new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000), now),
    "30_PLUS_DAYS"
  );
});
