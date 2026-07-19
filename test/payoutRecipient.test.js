import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import {
  calculateDestinationChargeAmounts,
  resolvePayoutRecipient,
} from "../src/modules/billing/payoutRecipient.service.js";
import { EarningTransaction } from "../src/modules/earning/earningTransaction.model.js";
import { Invoice } from "../src/modules/invoice/invoice.model.js";
import { createStripePaymentIntent } from "../src/modules/billing/stripe.service.js";

const readyConnect = (accountId) => ({
  stripeConnectAccountId: accountId,
  stripeConnectOnboardingComplete: true,
  stripeConnectDetailsSubmitted: true,
  stripeConnectChargesEnabled: true,
  stripeConnectTransfersEnabled: true,
  stripeConnectPayoutsEnabled: true,
});

const user = (role, profileName, accountId) => ({
  _id: new mongoose.Types.ObjectId(),
  role,
  [profileName]: readyConnect(accountId),
});

test("independent mechanic is the payout recipient", async () => {
  const mechanic = user("MECHANIC", "mechanicProfile", "acct_mechanic");
  const result = await resolvePayoutRecipient({ assignedMechanic: mechanic });

  assert.equal(result.userId, mechanic._id);
  assert.equal(result.recipientType, "MECHANIC");
  assert.equal(result.stripeConnectAccountId, "acct_mechanic");
});

test("company is recipient even when an employee mechanic performs the job", async () => {
  const company = user("COMPANY", "companyProfile", "acct_company");
  const employee = {
    _id: new mongoose.Types.ObjectId(),
    role: "MECHANIC_EMPLOYEE",
    mechanicProfile: readyConnect("acct_employee"),
  };

  const result = await resolvePayoutRecipient({
    assignedCompany: company,
    assignedMechanic: employee,
  });

  assert.equal(result.userId, company._id);
  assert.equal(result.recipientType, "COMPANY");
  assert.equal(result.stripeConnectAccountId, "acct_company");
});

test("employee mechanic can never be an independent payout recipient", async () => {
  const employee = {
    _id: new mongoose.Types.ObjectId(),
    role: "MECHANIC_EMPLOYEE",
    mechanicProfile: readyConnect("acct_employee"),
  };

  await assert.rejects(
    resolvePayoutRecipient({ assignedMechanic: employee }),
    /Employee mechanics cannot receive job payouts/
  );
});

test("payment is blocked when recipient Connect onboarding is incomplete", async () => {
  const mechanic = user("MECHANIC", "mechanicProfile", "acct_incomplete");
  mechanic.mechanicProfile.stripeConnectPayoutsEnabled = false;

  await assert.rejects(
    resolvePayoutRecipient({ assignedMechanic: mechanic }),
    /Stripe Connect onboarding must be completed/
  );
});

test("PaymentIntent creation rejects a missing destination account", async () => {
  await assert.rejects(
    createStripePaymentIntent({
      amount: 100,
      customerId: "cus_test",
      paymentMethodId: "pm_test",
      platformFeeAmount: 12,
    }),
    /payout destination is required/
  );
});

test("12% platform fee uses integer minor units and supplier receives VAT", () => {
  const amounts = calculateDestinationChargeAmounts({
    subtotal: 100,
    vatAmount: 20,
    platformFeePercent: 12,
  });

  assert.deepEqual(amounts, {
    subtotalMinor: 10_000,
    vatMinor: 2_000,
    chargeAmountMinor: 12_000,
    platformFeeMinor: 1_200,
    recipientAmountMinor: 10_800,
  });
});

test("12% fee rounds once in minor units", () => {
  const amounts = calculateDestinationChargeAmounts({
    subtotal: 10.01,
    vatAmount: 2,
    platformFeePercent: 12,
  });

  assert.equal(amounts.platformFeeMinor, 120);
  assert.equal(amounts.recipientAmountMinor, 1081);
});

test("company job financial records credit the company, not its employee", async () => {
  const companyId = new mongoose.Types.ObjectId();
  const employeeId = new mongoose.Types.ObjectId();
  const jobId = new mongoose.Types.ObjectId();

  const earning = new EarningTransaction({
    company: companyId,
    job: jobId,
    grossAmount: 100,
    platformFee: 12,
    netAmount: 88,
  });
  await earning.validate();
  assert.equal(earning.company.toString(), companyId.toString());
  assert.equal(earning.mechanic, undefined);

  const invoice = new Invoice({
    invoiceNo: `TEST-${jobId}`,
    job: jobId,
    fleet: new mongoose.Types.ObjectId(),
    company: companyId,
    performedByMechanic: employeeId,
    subtotal: 100,
    totalAmount: 100,
  });
  await invoice.validate();
  assert.equal(invoice.company.toString(), companyId.toString());
  assert.equal(invoice.mechanic, undefined);
  assert.equal(invoice.performedByMechanic.toString(), employeeId.toString());
});
