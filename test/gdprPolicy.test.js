import test from "node:test";
import assert from "node:assert/strict";

import { DATA_RETENTION_POLICY } from "../src/modules/gdpr/gdpr.policy.js";

test("retention policy declares version and review metadata", () => {
  assert.ok(DATA_RETENTION_POLICY.version);
  assert.ok(DATA_RETENTION_POLICY.lastReviewed);
  assert.ok(DATA_RETENTION_POLICY.principles.length > 0);
});

test("every retention category is fully specified", () => {
  assert.ok(DATA_RETENTION_POLICY.categories.length >= 5);
  for (const category of DATA_RETENTION_POLICY.categories) {
    for (const field of [
      "key",
      "dataCategory",
      "description",
      "retentionPeriod",
      "legalBasis",
      "erasureBehavior",
    ]) {
      assert.ok(
        typeof category[field] === "string" && category[field].length > 0,
        `category ${category.key || "?"} missing ${field}`
      );
    }
  }
});

test("category keys are unique", () => {
  const keys = DATA_RETENTION_POLICY.categories.map((category) => category.key);
  assert.equal(new Set(keys).size, keys.length);
});
