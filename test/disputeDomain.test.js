import test from "node:test";
import assert from "node:assert/strict";
import { ROLES } from "../src/constants/domain.js";
import {
  TRANSITIONS,
  assertDisputeActionPermission,
  isJobParticipant,
} from "../src/modules/dispute/dispute.service.js";
import { detectEvidenceMime } from "../src/modules/dispute/disputeEvidenceStorage.service.js";
import { DisputeFinancialAction } from "../src/modules/dispute/disputeFinancialAction.model.js";

test("dispute transitions prohibit party-controlled resolution paths", () => {
  assert.deepEqual(TRANSITIONS.OPEN, ["TRIAGE", "ESCALATED"]);
  assert.equal(TRANSITIONS.OPEN.includes("RESOLVED"), false);
  assert.equal(TRANSITIONS.INVESTIGATING.includes("DECISION_PENDING"), true);
  assert.equal(TRANSITIONS.RESOLVED.includes("CLOSED"), true);
  assert.equal(TRANSITIONS.RESOLVED.includes("APPEALED"), true);
});

test("dispute action permissions separate party and admin actions", () => {
  assert.doesNotThrow(() =>
    assertDisputeActionPermission({ role: ROLES.FLEET }, "OPEN_CASE")
  );
  assert.throws(
    () =>
      assertDisputeActionPermission({ role: ROLES.FLEET }, "DECIDE_CASE"),
    /Permission denied/
  );
  assert.doesNotThrow(() =>
    assertDisputeActionPermission({ role: ROLES.ADMIN }, "DECIDE_CASE")
  );
  assert.throws(
    () =>
      assertDisputeActionPermission(
        { role: ROLES.MECHANIC_EMPLOYEE },
        "INTERNAL_NOTE"
      ),
    /Permission denied/
  );
});

test("job participant authorization covers every portal role", () => {
  const job = {
    fleet: "fleet-1",
    assignedCompany: "company-1",
    assignedMechanic: "mechanic-1",
  };
  assert.equal(isJobParticipant(job, { _id: "fleet-1", role: ROLES.FLEET }), true);
  assert.equal(isJobParticipant(job, { _id: "company-1", role: ROLES.COMPANY }), true);
  assert.equal(isJobParticipant(job, { _id: "mechanic-1", role: ROLES.MECHANIC }), true);
  assert.equal(
    isJobParticipant(job, { _id: "mechanic-1", role: ROLES.MECHANIC_EMPLOYEE }),
    true
  );
  assert.equal(isJobParticipant(job, { _id: "outsider", role: ROLES.FLEET }), false);
  assert.equal(isJobParticipant(job, { _id: "admin", role: ROLES.ADMIN }), true);
});

test("evidence MIME is derived from bytes and rejects spoofed content", () => {
  const pdf = Buffer.from("%PDF-1.7\n");
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  assert.equal(detectEvidenceMime(pdf), "application/pdf");
  assert.equal(detectEvidenceMime(png), "image/png");
  assert.equal(detectEvidenceMime(Buffer.from("not an image")), null);
});

test("financial actions enforce a unique idempotency key", () => {
  const uniqueIndex = DisputeFinancialAction.schema
    .indexes()
    .find(([fields]) => fields.idempotencyKey === 1);
  assert.equal(uniqueIndex?.[1]?.unique, true);
});
