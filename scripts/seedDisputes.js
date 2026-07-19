import dotenv from "dotenv";
import mongoose from "mongoose";
import { Dispute } from "../src/modules/dispute/dispute.model.js";
import { DisputeEvent } from "../src/modules/dispute/disputeEvent.model.js";
import { DisputeMessage } from "../src/modules/dispute/disputeMessage.model.js";
import { Invoice } from "../src/modules/invoice/invoice.model.js";

dotenv.config();

const apply = process.argv.includes("--apply");
const fixtures = [
  { suffix: "OPEN", status: "OPEN", reasonCode: "QUALITY", priority: "MEDIUM" },
  { suffix: "EVIDENCE", status: "AWAITING_CUSTOMER_EVIDENCE", reasonCode: "DAMAGE", priority: "HIGH" },
  { suffix: "DECISION", status: "DECISION_PENDING", reasonCode: "OVERCHARGE", priority: "HIGH" },
  { suffix: "PARTIAL", status: "RESOLVED", reasonCode: "INCORRECT_PARTS", priority: "MEDIUM", outcome: "PARTIAL_REFUND" },
  { suffix: "RESOLVED", status: "RESOLVED", reasonCode: "NO_SHOW", priority: "LOW", outcome: "NO_ACTION" },
  { suffix: "CHARGEBACK", status: "INVESTIGATING", reasonCode: "CHARGEBACK", priority: "HIGH", chargeback: true },
];

const run = async () => {
  if (!process.env.MONGODB_URL) throw new Error("Missing MONGODB_URL");
  await mongoose.connect(process.env.MONGODB_URL);
  const invoices = await Invoice.find({
    job: { $ne: null },
    fleet: { $ne: null },
    mechanic: { $ne: null },
  })
    .sort({ createdAt: -1 })
    .limit(fixtures.length)
    .lean();
  const report = {
    mode: apply ? "APPLY" : "DRY_RUN",
    availableTransactions: invoices.length,
    planned: Math.min(invoices.length, fixtures.length),
    seeded: 0,
  };
  if (!apply) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  for (let index = 0; index < Math.min(invoices.length, fixtures.length); index += 1) {
    const invoice = invoices[index];
    const fixture = fixtures[index];
    const caseNo = `DSP-SEED-${fixture.suffix}`;
    const amountMinor = Math.round(Number(invoice.totalAmount || 0) * 100);
    const dispute = await Dispute.findOneAndUpdate(
      { caseNo },
      {
        $set: {
          caseType: fixture.chargeback ? "STRIPE_CHARGEBACK" : "SERVICE_DISPUTE",
          title: `Seed ${fixture.suffix.toLowerCase()} dispute`,
          description: "Realistic seeded case for operational verification and UI testing.",
          reason: "Seeded verification scenario",
          reasonCode: fixture.reasonCode,
          claimant: invoice.fleet,
          claimantRole: "FLEET",
          respondent: invoice.mechanic,
          respondentRole: "MECHANIC",
          createdBy: invoice.fleet,
          company: invoice.fleet,
          mechanic: invoice.mechanic,
          job: invoice.job,
          invoice: invoice._id,
          amount: amountMinor / 100,
          amountMinor,
          currency: invoice.currency || "GBP",
          priority: fixture.priority,
          status: fixture.status,
          versionNumber: 1,
          responseDueAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
          evidenceDueAt: new Date(Date.now() + 36 * 60 * 60 * 1000),
          decisionDueAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
          nextActionOwner: fixture.status.includes("EVIDENCE") ? "CLAIMANT" : "ADMIN",
          processorStatus: fixture.chargeback ? "NEEDS_RESPONSE" : "NONE",
          stripeDisputeId: fixture.chargeback ? "dp_seed_chargeback" : undefined,
          financialState: fixture.outcome === "PARTIAL_REFUND" ? "PARTIALLY_ADJUSTED" : "NO_ACTION",
          decision: fixture.outcome
            ? {
                outcome: fixture.outcome,
                findings: "Seeded findings demonstrate a completed evidence review.",
                rationale: "Seeded rationale demonstrates the resulting remedy.",
                amountMinor: fixture.outcome === "PARTIAL_REFUND" ? Math.round(amountMinor / 2) : 0,
                decidedAt: new Date(),
              }
            : undefined,
          resolvedAt: fixture.status === "RESOLVED" ? new Date() : undefined,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    await DisputeEvent.updateOne(
      { dispute: dispute._id, correlationId: `seed:${fixture.suffix}` },
      {
        $setOnInsert: {
          dispute: dispute._id,
          source: "SYSTEM",
          type: "SEED_CASE_CREATED",
          toStatus: fixture.status,
          correlationId: `seed:${fixture.suffix}`,
        },
      },
      { upsert: true }
    );
    await DisputeMessage.updateOne(
      { dispute: dispute._id, body: "Please review the attached service history and invoice." },
      {
        $setOnInsert: {
          dispute: dispute._id,
          sender: invoice.fleet,
          senderRole: "FLEET",
          visibility: "PARTIES",
          body: "Please review the attached service history and invoice.",
        },
      },
      { upsert: true }
    );
    report.seeded += 1;
  }
  console.log(JSON.stringify(report, null, 2));
};

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => mongoose.connection.close());
