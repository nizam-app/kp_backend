import test from "node:test";
import assert from "node:assert/strict";

import { calculateJobVat, resolveJobVatPolicy } from "../src/utils/vat.js";

test("does not apply VAT for a non-registered mechanic", () => {
  const job = {
    assignedMechanic: {
      _id: "mechanic-1",
      mechanicProfile: {
        displayName: "Roadside Repairs",
        vatRegistered: false,
        vatNumber: "GB123456789",
      },
    },
  };

  assert.deepEqual(calculateJobVat(job, 100), {
    supplierType: "MECHANIC",
    supplierId: "mechanic-1",
    supplierName: "Roadside Repairs",
    vatRegistered: false,
    vatNumber: null,
    vatRate: 0,
    subtotal: 100,
    vatAmount: 0,
    totalAmount: 100,
  });
});

test("applies 20 percent VAT for a registered mechanic", () => {
  const job = {
    assignedMechanic: {
      _id: "mechanic-1",
      mechanicProfile: {
        businessName: "Roadside Repairs Ltd",
        vatRegistered: true,
        vatNumber: "GB123456789",
      },
    },
  };

  const result = calculateJobVat(job, 99.99);
  assert.equal(result.vatAmount, 20);
  assert.equal(result.totalAmount, 119.99);
  assert.equal(result.vatRate, 0.2);
});

test("uses the assigned company as supplier instead of its employee", () => {
  const job = {
    assignedCompany: {
      _id: "company-1",
      companyProfile: {
        companyName: "Workshop Ltd",
        vatRegistered: false,
      },
    },
    assignedMechanic: {
      _id: "employee-1",
      mechanicProfile: {
        vatRegistered: true,
        vatNumber: "GB987654321",
      },
    },
  };

  const policy = resolveJobVatPolicy(job);
  assert.equal(policy.supplierType, "COMPANY");
  assert.equal(policy.supplierId, "company-1");
  assert.equal(policy.vatRegistered, false);
  assert.equal(calculateJobVat(job, 250).totalAmount, 250);
});

