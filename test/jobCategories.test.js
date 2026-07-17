import test from "node:test";
import assert from "node:assert/strict";

import {
  JOB_CATEGORY_SUBTYPE_TO_ISSUE_TYPE,
  issueTypeValues,
} from "../src/constants/domain.js";
import { DEFAULT_JOB_CATEGORIES } from "../src/modules/jobCategory/jobCategory.defaults.js";

test("all canonical Fleet job categories have unique stable keys", () => {
  assert.equal(DEFAULT_JOB_CATEGORIES.length, 12);
  const keys = DEFAULT_JOB_CATEGORIES.map((category) => category.key);
  assert.equal(new Set(keys).size, keys.length);
});

test("all canonical categories resolve to a valid granular issue type", () => {
  for (const category of DEFAULT_JOB_CATEGORIES) {
    assert.ok(issueTypeValues.includes(category.issueType), category.key);
    assert.equal(
      JOB_CATEGORY_SUBTYPE_TO_ISSUE_TYPE[category.key],
      category.issueType,
      category.key
    );
  }
});

test("canonical categories keep deterministic display order", () => {
  const orders = DEFAULT_JOB_CATEGORIES.map((category) => category.sortOrder);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
});
