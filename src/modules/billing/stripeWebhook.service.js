import AppError from "../../utils/AppError.js";
import { Invoice } from "../invoice/invoice.model.js";
import { Job } from "../job/job.model.js";
import { JobEvent } from "../jobEvent/jobEvent.model.js";
import { EarningTransaction } from "../earning/earningTransaction.model.js";

const invoiceStatusFromPaymentIntent = (status) => {
  switch (`${status || ""}`) {
    case "succeeded":
      return { invoiceStatus: "PAID", paymentStatus: "SUCCEEDED", markPaid: true };
    case "processing":
      return { invoiceStatus: "ISSUED", paymentStatus: "PROCESSING", markPaid: false };
    case "requires_action":
      return {
        invoiceStatus: "ISSUED",
        paymentStatus: "REQUIRES_ACTION",
        markPaid: false,
      };
    case "requires_payment_method":
      return {
        invoiceStatus: "FAILED",
        paymentStatus: "REQUIRES_PAYMENT_METHOD",
        markPaid: false,
      };
    case "canceled":
      return { invoiceStatus: "VOID", paymentStatus: "CANCELED", markPaid: false };
    default:
      return { invoiceStatus: "ISSUED", paymentStatus: "PENDING", markPaid: false };
  }
};

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
  const platformFee = roundAmount(grossAmount * 0.12);
  const netAmount = Math.max(roundAmount(grossAmount - platformFee), 0);

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

const applyPaymentIntentToInvoice = async (paymentIntent) => {
  const invoice = await findInvoiceForPaymentIntent(paymentIntent);
  if (!invoice) {
    return { ok: true, ignored: true, reason: "invoice_not_found" };
  }

  const statusMap = invoiceStatusFromPaymentIntent(paymentIntent.status);
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

export const processStripeWebhookEvent = async (event) => {
  if (!event?.type) throw new AppError("Stripe webhook event type is required", 400);

  switch (event.type) {
    case "payment_intent.succeeded":
    case "payment_intent.processing":
    case "payment_intent.payment_failed":
    case "payment_intent.canceled":
    case "payment_intent.requires_action":
      return applyPaymentIntentToInvoice(event.data?.object || {});
    case "charge.refunded":
      return applyRefundToInvoice(event.data?.object || {});
    default:
      return {
        ok: true,
        ignored: true,
        reason: "event_not_handled",
        eventType: event.type,
      };
  }
};
