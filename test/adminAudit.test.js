import test from "node:test";
import assert from "node:assert/strict";

import { deriveAdminAuditDescriptor } from "../src/modules/admin/adminAudit.util.js";

test("ignores read-only admin requests", () => {
  assert.equal(
    deriveAdminAuditDescriptor({ method: "GET", routePath: "/reports" }),
    null
  );
});

test("classifies an unaudited mechanic approval mutation", () => {
  assert.deepEqual(
    deriveAdminAuditDescriptor({
      method: "PATCH",
      routePath: "/mechanics/:userId/approve",
      params: { userId: "mechanic-1" },
    }),
    {
      action: "PATCH /mechanics/:userId/approve",
      target: "mechanic-1",
      category: "Mechanic Verification",
    }
  );
});

test("classifies support, dispute, catalog and category mutations", () => {
  const cases = [
    ["/support/:ticketId", "Support"],
    ["/disputes/:disputeId", "Disputes"],
    ["/service-catalog/:serviceId", "Service Catalog"],
    ["/job-categories/:categoryId", "Job Categories"],
    ["/promotions/:promotionId", "Promotions"],
    ["/reviews/:reviewId", "Reviews"],
  ];
  for (const [routePath, category] of cases) {
    assert.equal(
      deriveAdminAuditDescriptor({ method: "PATCH", routePath })?.category,
      category
    );
  }
});

test("uses safe identifying fields without serializing request bodies", () => {
  const result = deriveAdminAuditDescriptor({
    method: "POST",
    routePath: "/users",
    body: {
      email: "new-admin@example.com",
      password: "must-not-appear",
    },
  });
  assert.equal(result.target, "new-admin@example.com");
  assert.equal(JSON.stringify(result).includes("must-not-appear"), false);
});
