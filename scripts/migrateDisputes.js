import crypto from "crypto";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { Dispute } from "../src/modules/dispute/dispute.model.js";
import { DisputeEvent } from "../src/modules/dispute/disputeEvent.model.js";
import { DisputeMessage } from "../src/modules/dispute/disputeMessage.model.js";
import { DisputeEvidence } from "../src/modules/dispute/disputeEvidence.model.js";
import { DisputeTask } from "../src/modules/dispute/disputeTask.model.js";
import { DisputeFinancialAction } from "../src/modules/dispute/disputeFinancialAction.model.js";
import { Invoice } from "../src/modules/invoice/invoice.model.js";
import { Job } from "../src/modules/job/job.model.js";
import { Refund } from "../src/modules/billing/refund.model.js";
import { SupportTicket } from "../src/modules/supportTicket/supportTicket.model.js";

dotenv.config();

const apply = process.argv.includes("--apply");
const makeCaseNo = (id) =>
  `DSP-MIG-${`${id}`.slice(-8).toUpperCase()}-${crypto
    .createHash("sha1")
    .update(`${id}`)
    .digest("hex")
    .slice(0, 4)
    .toUpperCase()}`;

const run = async () => {
  if (!process.env.MONGODB_URL) throw new Error("Missing MONGODB_URL");
  await mongoose.connect(process.env.MONGODB_URL);
  const disputes = await Dispute.find({}).lean();
  const report = {
    mode: apply ? "APPLY" : "DRY_RUN",
    scanned: disputes.length,
    ready: 0,
    updated: 0,
    ambiguous: [],
    linkedRefundCandidates: 0,
  };
  const operations = [];

  for (const dispute of disputes) {
    let job = dispute.job ? await Job.findById(dispute.job).lean() : null;
    let invoice = dispute.invoice ? await Invoice.findById(dispute.invoice).lean() : null;
    if (!job && invoice?.job) job = await Job.findById(invoice.job).lean();
    if (!invoice && job) invoice = await Invoice.findOne({ job: job._id }).lean();
    const problems = [];
    if (!job) problems.push("job_missing");
    if (invoice && job && `${invoice.job}` !== `${job._id}`) {
      problems.push("invoice_job_mismatch");
    }
    if (job && dispute.company && `${job.fleet}` !== `${dispute.company}`) {
      problems.push("fleet_mismatch");
    }
    if (job && dispute.mechanic && `${job.assignedMechanic}` !== `${dispute.mechanic}`) {
      problems.push("mechanic_mismatch");
    }
    if (problems.length) {
      report.ambiguous.push({ disputeId: dispute._id, problems });
      continue;
    }
    const refunds = invoice
      ? await Refund.countDocuments({ invoice: invoice._id })
      : 0;
    report.linkedRefundCandidates += refunds;
    const amount = Number(invoice?.totalAmount ?? dispute.amount ?? 0);
    const processorStatus = invoice?.payment?.disputeStatus
      ? `${invoice.payment.disputeStatus}`.toUpperCase()
      : dispute.processorStatus || "NONE";
    operations.push({
      updateOne: {
        filter: { _id: dispute._id },
        update: {
          $set: {
            caseNo: dispute.caseNo || makeCaseNo(dispute._id),
            caseType:
              processorStatus !== "NONE"
                ? "STRIPE_CHARGEBACK"
                : dispute.caseType || "SERVICE_DISPUTE",
            reasonCode: dispute.reasonCode || "OTHER",
            claimant: dispute.claimant || job.fleet,
            claimantRole: dispute.claimantRole || "FLEET",
            respondent: dispute.respondent || job.assignedMechanic,
            respondentRole: dispute.respondentRole || "MECHANIC",
            createdBy: dispute.createdBy || dispute.claimant || job.fleet,
            job: job._id,
            invoice: invoice?._id,
            amount,
            amountMinor: Math.round(amount * 100),
            status:
              dispute.status === "IN_REVIEW"
                ? "INVESTIGATING"
                : dispute.status,
            versionNumber: dispute.versionNumber || 1,
            assignedTeam: dispute.assignedTeam || "DISPUTES",
            nextActionOwner: dispute.nextActionOwner || "ADMIN",
            processorStatus,
            financialState: dispute.financialState || "NO_ACTION",
            responseDueAt:
              dispute.responseDueAt ||
              new Date(new Date(dispute.createdAt).getTime() + 24 * 60 * 60 * 1000),
            decisionDueAt:
              dispute.decisionDueAt ||
              new Date(new Date(dispute.createdAt).getTime() + 7 * 24 * 60 * 60 * 1000),
          },
        },
      },
    });
    report.ready += 1;
  }

  if (apply && operations.length) {
    const result = await Dispute.bulkWrite(operations, { ordered: false });
    report.updated = result.modifiedCount;
    await Promise.all([
      Dispute.syncIndexes(),
      DisputeEvent.syncIndexes(),
      DisputeMessage.syncIndexes(),
      DisputeEvidence.syncIndexes(),
      DisputeTask.syncIndexes(),
      DisputeFinancialAction.syncIndexes(),
      SupportTicket.syncIndexes(),
    ]);
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.ambiguous.length) process.exitCode = 2;
};

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => mongoose.connection.close());
