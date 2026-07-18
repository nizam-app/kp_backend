import { Invoice } from "../invoice/invoice.model.js";
import { Job } from "../job/job.model.js";
import { createNotification } from "../notification/notification.service.js";
import { retrieveStripePaymentIntent } from "./stripe.service.js";
import { applyPaymentIntentToInvoice } from "./stripeWebhook.service.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const paymentAgingBucket = (dateValue, now = new Date()) => {
  if (!dateValue) return "UNKNOWN";
  const days = Math.max(
    0,
    Math.floor((now.getTime() - new Date(dateValue).getTime()) / DAY)
  );
  if (days <= 1) return "0_1_DAYS";
  if (days <= 7) return "2_7_DAYS";
  if (days <= 14) return "8_14_DAYS";
  if (days <= 30) return "15_30_DAYS";
  return "30_PLUS_DAYS";
};

const collectionStateAt = (dueAt, now) => {
  if (!dueAt || now <= new Date(dueAt)) return "ACTION_REQUIRED";
  return now.getTime() - new Date(dueAt).getTime() >= 7 * DAY
    ? "ESCALATED"
    : "OVERDUE";
};

const nextReminderAt = (reminderCount, now) => {
  const delays = [23 * HOUR, 2 * DAY, 4 * DAY, 7 * DAY];
  return new Date(now.getTime() + delays[Math.min(reminderCount, delays.length - 1)]);
};

const reconcileStuckStripePayments = async (now) => {
  const staleBefore = new Date(now.getTime() - 5 * 60 * 1000);
  const invoices = await Invoice.find({
    status: "ISSUED",
    "payment.provider": "STRIPE",
    "payment.status": { $in: ["PROCESSING", "REQUIRES_ACTION"] },
    "payment.stripePaymentIntentId": { $exists: true, $ne: null },
    "payment.updatedAt": { $lte: staleBefore },
  })
    .sort({ "payment.updatedAt": 1 })
    .limit(100)
    .select("_id payment.stripePaymentIntentId")
    .lean();

  let reconciled = 0;
  let failed = 0;
  for (const invoice of invoices) {
    try {
      const intent = await retrieveStripePaymentIntent(
        invoice.payment.stripePaymentIntentId
      );
      await applyPaymentIntentToInvoice(intent, {
        source: "ADMIN",
        eventType: "SCHEDULED_RECONCILIATION",
      });
      reconciled += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `[payment-ops] reconcile ${invoice._id}:`,
        err?.message || err
      );
    }
  }
  return { checked: invoices.length, reconciled, failed };
};

const sendDuePaymentReminders = async (now) => {
  const jobs = await Job.find({
    status: "AWAITING_APPROVAL",
    paymentNextReminderAt: { $lte: now },
  })
    .sort({ paymentNextReminderAt: 1 })
    .limit(200)
    .select(
      "_id jobCode title fleet assignedCompany paymentDueAt paymentNextReminderAt paymentReminderCount finalAmount acceptedAmount currency"
    )
    .lean();

  let sent = 0;
  let skipped = 0;
  for (const job of jobs) {
    const count = Number(job.paymentReminderCount || 0);
    const state = collectionStateAt(job.paymentDueAt, now);
    const nextAt = nextReminderAt(count, now);
    const claimed = await Job.findOneAndUpdate(
      {
        _id: job._id,
        status: "AWAITING_APPROVAL",
        paymentNextReminderAt: job.paymentNextReminderAt,
      },
      {
        $set: {
          paymentLastReminderAt: now,
          paymentNextReminderAt: nextAt,
          paymentCollectionState: state,
        },
        $inc: { paymentReminderCount: 1 },
      },
      { new: true }
    );
    if (!claimed) {
      skipped += 1;
      continue;
    }

    const payerId = job.assignedCompany || job.fleet;
    if (!payerId) {
      skipped += 1;
      continue;
    }
    const amount = Number(job.finalAmount ?? job.acceptedAmount ?? 0);
    const amountText = amount > 0 ? ` £${amount.toFixed(2)}` : "";
    await createNotification({
      user: payerId,
      type: "PAYMENT_ACTION_REQUIRED",
      eventKey: "PAYMENT_REMINDER",
      dedupeKey: `job:${job._id}:reminder:${count + 1}`,
      title:
        state === "ESCALATED"
          ? `Overdue payment requires attention`
          : `Approve and pay for ${job.jobCode}`,
      body:
        state === "ACTION_REQUIRED"
          ? `Work is complete. Review the final bill${amountText} and approve payment.`
          : `Payment${amountText} is overdue. Review the completed work and resolve payment now.`,
      data: {
        jobId: job._id.toString(),
        jobCode: job.jobCode,
        collectionState: state,
        agingBucket: paymentAgingBucket(job.paymentDueAt, now),
        screen: "JOB_DETAIL",
      },
    });

    await Invoice.updateOne(
      { job: job._id, status: { $in: ["ISSUED", "FAILED"] } },
      {
        $set: {
          dueAt: job.paymentDueAt,
          "collections.state": state,
          "collections.lastReminderAt": now,
          "collections.nextReminderAt": nextAt,
        },
        $inc: { "collections.reminderCount": 1 },
      }
    );
    sent += 1;
  }
  return { due: jobs.length, sent, skipped };
};

export const runPaymentOperations = async ({ now = new Date() } = {}) => {
  const reconciliation = await reconcileStuckStripePayments(now);
  const reminders = await sendDuePaymentReminders(now);
  return { ranAt: now, reconciliation, reminders };
};
