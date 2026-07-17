import AppError from "../../utils/AppError.js";
import { Invoice } from "../invoice/invoice.model.js";
import { Job } from "../job/job.model.js";
import { JobEvent } from "../jobEvent/jobEvent.model.js";
import { EarningTransaction } from "../earning/earningTransaction.model.js";
import { StripeWebhookEvent } from "./stripeWebhookEvent.model.js";
import { completeJobOnConfirmedPayment } from "../job/job.service.js";
import {
  invoiceStatusFromPaymentIntent,
  shouldSkipDowngrade,
} from "./stripePaymentStatus.js";
import {
  computePlatformFeeNet,
  getPlatformFeePercent,
} from "../../utils/platformFee.js";
import { notifyAdminsSafely } from "../notification/adminNotification.service.js";
import { ADMIN_NOTIFICATION_EVENTS } from "../notification/adminNotificationEvents.js";

const roundAmount = (value) =>
  Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

const minorToMajor = (minorAmount) => roundAmount((Number(minorAmount || 0) || 0) / 100);

const createLifecycleJobEvent = async ({ job, type, note, payload }) => {
  if (!job?._id) return;

  await JobEvent.create({
    job: job._id,
    actor: job.fleet,
    type,
    fromStatus: job.status,
    toStatus: job.status,
    note,
    payload,
  });
};

const syncEarningForInvoice = async (invoice, { shouldBePaid }) => {
  if (!invoice?.mechanic || !invoice?.job) return null;

  const grossAmount = roundAmount(invoice.subtotal);
  const feePercent =
    invoice.platformFeePercent != null
      ? Number(invoice.platformFeePercent)
      : getPlatformFeePercent();
  const { platformFee, netAmount, platformFeePercent } = computePlatformFeeNet(
    grossAmount,
    feePercent
  );

  if (!shouldBePaid) {
    await EarningTransaction.deleteOne({
      mechanic: invoice.mechanic,
      job: invoice.job,
    });
    return null;
  }

  return EarningTransaction.findOneAndUpdate(
    { mechanic: invoice.mechanic, job: invoice.job },
    {
      $set: {
        grossAmount,
        platformFee,
        platformFeePercent,
        netAmount,
        currency: invoice.currency || "GBP",
        paidAt: invoice.paidAt || new Date(),
        notes: "Stripe webhook confirmed payout",
      },
      $setOnInsert: {
        type: "JOB_PAYMENT",
      },
    },
    { upsert: true, new: true }
  );
};

const findInvoiceForPaymentIntent = async (paymentIntent) => {
  const paymentIntentId = paymentIntent?.id;
  const jobId = paymentIntent?.metadata?.jobId;

  let invoice = null;
  if (paymentIntentId) {
    invoice = await Invoice.findOne({
      "payment.stripePaymentIntentId": paymentIntentId,
    });
  }

  if (!invoice && jobId) {
    invoice = await Invoice.findOne({ job: jobId });
  }

  return invoice;
};

export const applyPaymentIntentToInvoice = async (paymentIntent) => {
  const invoice = await findInvoiceForPaymentIntent(paymentIntent);
  if (!invoice) {
    return { ok: true, ignored: true, reason: "invoice_not_found" };
  }

  const statusMap = invoiceStatusFromPaymentIntent(paymentIntent.status);
  const previousPaymentStatus = invoice.payment?.status;

  // Monotonic guard: never downgrade a confirmed payment because a stale,
  // out-of-order event (e.g. a late "processing") arrives after "succeeded".
  if (shouldSkipDowngrade(previousPaymentStatus, statusMap)) {
    return {
      ok: true,
      ignored: true,
      reason: "already_paid_no_downgrade",
      invoiceId: invoice._id.toString(),
      paymentStatus: previousPaymentStatus,
    };
  }
  const paidAt =
    statusMap.markPaid && paymentIntent.created
      ? new Date(Number(paymentIntent.created) * 1000)
      : invoice.paidAt;

  invoice.status = statusMap.invoiceStatus;
  invoice.paidAt = statusMap.markPaid ? paidAt || new Date() : undefined;
  invoice.payment = {
    ...(invoice.payment || {}),
    provider: "STRIPE",
    status: statusMap.paymentStatus,
    stripeCustomerId: paymentIntent.customer || invoice.payment?.stripeCustomerId,
    stripePaymentMethodId:
      paymentIntent.payment_method || invoice.payment?.stripePaymentMethodId,
    stripePaymentIntentId: paymentIntent.id,
    stripeClientSecret:
      paymentIntent.client_secret || invoice.payment?.stripeClientSecret,
    lastError:
      paymentIntent.last_payment_error?.message || invoice.payment?.lastError || null,
    authorizedAmount:
      minorToMajor(paymentIntent.amount) || invoice.payment?.authorizedAmount,
    capturedAmount: statusMap.markPaid
      ? minorToMajor(paymentIntent.amount_received || paymentIntent.amount)
      : undefined,
    updatedAt: new Date(),
  };

  await invoice.save();
  await syncEarningForInvoice(invoice, { shouldBePaid: statusMap.markPaid });

  const job = await Job.findById(invoice.job);
  await createLifecycleJobEvent({
    job,
    type: "PAYMENT_UPDATED",
    note: `Stripe payment intent ${paymentIntent.status}`,
    payload: {
      invoiceId: invoice._id,
      stripePaymentIntentId: paymentIntent.id,
      paymentStatus: statusMap.paymentStatus,
      invoiceStatus: statusMap.invoiceStatus,
    },
  });

  // Finalize a job that was left awaiting approval pending authentication
  // (3D Secure) once the payment is confirmed asynchronously.
  if (statusMap.markPaid) {
    await completeJobOnConfirmedPayment(invoice.job, {
      paymentStatus: statusMap.paymentStatus,
    });
  }

  if (
    statusMap.invoiceStatus === "FAILED" &&
    previousPaymentStatus !== statusMap.paymentStatus
  ) {
    await notifyAdminsSafely({
      eventKey: ADMIN_NOTIFICATION_EVENTS.PAYMENT_FAILED,
      dedupeKey: `payment-failed:${paymentIntent.id || invoice._id}:${statusMap.paymentStatus}`,
      title: `Payment failed for invoice ${invoice.invoiceNo || invoice._id}`,
      body:
        invoice.payment?.lastError ||
        `Stripe payment ${paymentIntent.id || ""} requires a new payment method.`,
      data: {
        invoiceId: invoice._id.toString(),
        jobId: invoice.job?.toString?.() || null,
        paymentIntentId: paymentIntent.id || null,
        screen: "ADMIN_PAYMENT",
      },
    });
  }

  return {
    ok: true,
    invoiceId: invoice._id.toString(),
    paymentIntentId: paymentIntent.id,
    invoiceStatus: invoice.status,
    paymentStatus: invoice.payment?.status,
  };
};

const applyRefundToInvoice = async (charge) => {
  const paymentIntentId = charge?.payment_intent;
  if (!paymentIntentId) {
    return { ok: true, ignored: true, reason: "payment_intent_missing" };
  }

  const invoice = await Invoice.findOne({
    "payment.stripePaymentIntentId": paymentIntentId,
  });
  if (!invoice) {
    return { ok: true, ignored: true, reason: "invoice_not_found" };
  }

  invoice.status = "REFUNDED";
  invoice.payment = {
    ...(invoice.payment || {}),
    provider: "STRIPE",
    status: "REFUNDED",
    stripePaymentIntentId: paymentIntentId,
    capturedAmount: 0,
    updatedAt: new Date(),
  };
  await invoice.save();
  await syncEarningForInvoice(invoice, { shouldBePaid: false });

  const job = await Job.findById(invoice.job);
  await createLifecycleJobEvent({
    job,
    type: "PAYMENT_REFUNDED",
    note: "Stripe charge refunded",
    payload: {
      invoiceId: invoice._id,
      stripePaymentIntentId: paymentIntentId,
      refundedAmount: minorToMajor(charge.amount_refunded || charge.amount),
    },
  });

  return {
    ok: true,
    invoiceId: invoice._id.toString(),
    paymentIntentId,
    invoiceStatus: invoice.status,
    paymentStatus: invoice.payment?.status,
  };
};

const applyDisputeToInvoice = async (dispute) => {
  const paymentIntentId = dispute?.payment_intent;
  const chargeId = dispute?.charge;
  if (!paymentIntentId && !chargeId) {
    return { ok: true, ignored: true, reason: "payment_reference_missing" };
  }

  const invoice = paymentIntentId
    ? await Invoice.findOne({ "payment.stripePaymentIntentId": paymentIntentId })
    : null;
  if (!invoice) {
    return { ok: true, ignored: true, reason: "invoice_not_found" };
  }

  const closed = dispute?.status === "won" || dispute?.status === "lost";
  invoice.payment = {
    ...(invoice.payment || {}),
    provider: "STRIPE",
    disputeStatus: dispute?.status || "under_review",
    lastError: `Stripe dispute ${dispute?.status || "opened"}`,
    updatedAt: new Date(),
  };
  if (dispute?.status === "lost") invoice.status = "REFUNDED";
  await invoice.save();

  const job = await Job.findById(invoice.job);
  await createLifecycleJobEvent({
    job,
    type: "PAYMENT_DISPUTED",
    note: `Stripe dispute ${dispute?.status || "opened"}`,
    payload: {
      invoiceId: invoice._id,
      stripePaymentIntentId: paymentIntentId || null,
      disputeStatus: dispute?.status || null,
    },
  });

  await notifyAdminsSafely({
    eventKey: ADMIN_NOTIFICATION_EVENTS.PAYMENT_FAILED,
    dedupeKey: `payment-dispute:${dispute?.id || invoice._id}:${dispute?.status || "open"}`,
    title: `Chargeback ${dispute?.status || "opened"} on invoice ${invoice.invoiceNo || invoice._id}`,
    body: `A Stripe dispute is ${dispute?.status || "open"} for payment ${paymentIntentId || ""}.`,
    data: {
      invoiceId: invoice._id.toString(),
      jobId: invoice.job?.toString?.() || null,
      paymentIntentId: paymentIntentId || null,
      screen: "ADMIN_PAYMENT",
    },
  });

  return {
    ok: true,
    invoiceId: invoice._id.toString(),
    disputeStatus: dispute?.status || null,
    closed,
  };
};

const dispatchStripeEvent = async (event) => {
  switch (event.type) {
    case "payment_intent.succeeded":
    case "payment_intent.processing":
    case "payment_intent.payment_failed":
    case "payment_intent.canceled":
    case "payment_intent.requires_action":
      return applyPaymentIntentToInvoice(event.data?.object || {});
    case "charge.refunded":
      return applyRefundToInvoice(event.data?.object || {});
    case "charge.dispute.created":
    case "charge.dispute.updated":
    case "charge.dispute.closed":
      return applyDisputeToInvoice(event.data?.object || {});
    default:
      return {
        ok: true,
        ignored: true,
        reason: "event_not_handled",
        eventType: event.type,
      };
  }
};

export const processStripeWebhookEvent = async (event) => {
  if (!event?.type) throw new AppError("Stripe webhook event type is required", 400);

  // Idempotency ledger: Stripe delivers at-least-once. Claim the event id
  // first; a duplicate delivery is acknowledged without reprocessing.
  if (event.id) {
    try {
      await StripeWebhookEvent.create({ eventId: event.id, type: event.type });
    } catch (err) {
      if (err?.code === 11000) {
        return { ok: true, ignored: true, reason: "duplicate_event", eventId: event.id };
      }
      throw err;
    }
  }

  try {
    return await dispatchStripeEvent(event);
  } catch (err) {
    // Do not poison the idempotency ledger: a failed handler must be
    // retryable when Stripe redelivers the event.
    if (event.id) {
      await StripeWebhookEvent.deleteOne({ eventId: event.id });
    }
    throw err;
  }
};
