import dotenv from "dotenv";
import mongoose from "mongoose";
import { Invoice } from "../src/modules/invoice/invoice.model.js";
import { EarningTransaction } from "../src/modules/earning/earningTransaction.model.js";
import { PaymentAttempt } from "../src/modules/billing/paymentAttempt.model.js";
import { Refund } from "../src/modules/billing/refund.model.js";
import { Job } from "../src/modules/job/job.model.js";

dotenv.config();

const run = async () => {
  if (!process.env.MONGODB_URL) throw new Error("Missing MONGODB_URL");
  await mongoose.connect(process.env.MONGODB_URL);

  await EarningTransaction.updateMany(
    { type: { $exists: false } },
    { $set: { type: "JOB_PAYMENT" } }
  );

  const duplicateInvoices = await Invoice.aggregate([
    { $group: { _id: "$job", count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]);
  const duplicateJobPayments = await EarningTransaction.aggregate([
    { $match: { type: "JOB_PAYMENT" } },
    {
      $group: {
        _id: { job: "$job", mechanic: "$mechanic" },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]);
  if (duplicateInvoices.length || duplicateJobPayments.length) {
    throw new Error(
      `Resolve duplicates before migration: invoices=${duplicateInvoices.length}, jobPayments=${duplicateJobPayments.length}`
    );
  }

  await Invoice.updateMany(
    { "payment.stripeClientSecret": { $exists: true } },
    { $unset: { "payment.stripeClientSecret": 1 } }
  );
  await Invoice.updateMany(
    { status: "AUTHORIZED" },
    {
      $set: {
        status: "ISSUED",
        "payment.status": "PENDING",
        "collections.state": "ACTION_REQUIRED",
      },
    }
  );
  await Job.updateMany(
    {
      status: "AWAITING_APPROVAL",
      paymentDueAt: { $exists: false },
    },
    [
      {
        $set: {
          paymentDueAt: { $add: ["$updatedAt", 24 * 60 * 60 * 1000] },
          paymentNextReminderAt: new Date(),
          paymentReminderCount: { $ifNull: ["$paymentReminderCount", 0] },
          paymentCollectionState: "ACTION_REQUIRED",
        },
      },
    ],
    { updatePipeline: true }
  );
  await Invoice.updateMany(
    { dueAt: { $exists: false } },
    [
      {
        $set: {
          dueAt: { $add: ["$issuedAt", 24 * 60 * 60 * 1000] },
          collections: {
            state: {
              $cond: [
                {
                  $in: [
                    "$status",
                    ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"],
                  ],
                },
                "RESOLVED",
                "ACTION_REQUIRED",
              ],
            },
            reminderCount: 0,
            nextReminderAt: {
              $cond: [
                {
                  $in: [
                    "$status",
                    ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"],
                  ],
                },
                null,
                { $add: ["$issuedAt", 60 * 60 * 1000] },
              ],
            },
          },
        },
      },
    ],
    { updatePipeline: true }
  );
  const earningIndexes = await EarningTransaction.collection.indexes();
  if (earningIndexes.some((index) => index.name === "job_1_mechanic_1")) {
    await EarningTransaction.collection.dropIndex("job_1_mechanic_1");
  }

  await Promise.all([
    Invoice.syncIndexes(),
    EarningTransaction.syncIndexes(),
    PaymentAttempt.syncIndexes(),
    Refund.syncIndexes(),
    Job.syncIndexes(),
  ]);
  console.log("Payment accounting migration complete");
};

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
