import AppError from "../../utils/AppError.js";
import { Invoice } from "../invoice/invoice.model.js";
import { Job } from "../job/job.model.js";
import { JobEvent } from "../jobEvent/jobEvent.model.js";
import { EarningTransaction } from "../earning/earningTransaction.model.js";
import { StripeWebhookEvent } from "./stripeWebhookEvent.model.js";
import { PaymentAttempt } from "./paymentAttempt.model.js";
import { Refund } from "./refund.model.js";
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
import { Dispute } from "../dispute/dispute.model.js";
import { DisputeEvent } from "../dispute/disputeEvent.model.js";
import { DisputeFinancialAction } from "../dispute/disputeFinancialAction.model.js";
import { User } from "../user/user.model.js";
import {
  retrieveStripeConnectAccount,
  syncStripeConnectAccountFromWebhook,
} from "./stripe.service.js";

const roundAmount = (value) =>
  Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

const minorToMajor = (minorAmount) => roundAmount((Number(minorAmount || 0) || 0) / 100);

const earningRecipientForInvoice = (invoice) =>
  invoice?.company
    ? { company: invoice.company }
    : invoice?.mechanic
      ? { mechanic: invoice.mechanic }
      : null;

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
  const recipient = earningRecipientForInvoice(invoice);
  if (!recipient || !invoice?.job) return null;

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
      job: invoice.job,
      type: "JOB_PAYMENT",
    });
    return null;
  }

  return EarningTransaction.findOneAndUpdate(
    { job: invoice.job, type: "JOB_PAYMENT" },
    {
      $set: {
        ...recipient,
        grossAmount,
        platformFee,
        platformFeePercent,
        netAmount,
        currency: invoice.currency || "GBP",
        paidAt: invoice.paidAt || new Date(),
        notes: "Stripe webhook confirmed payout",
      },
      $unset: recipient.company ? { mechanic: 1 } : { company: 1 },
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
    invoice = await Invoice.findOne({
      job: jobId,
      $or: [
        { "payment.stripePaymentIntentId": paymentIntentId },
        { "payment.stripePaymentIntentId": { $exists: false } },
        { "payment.stripePaymentIntentId": null },
      ],
    });
  }

  return invoice;
};

export const applyPaymentIntentToInvoice = async (
  paymentIntent,
  { source = "SYNC", eventType = "PAYMENT_INTENT_SYNCED", externalEventId } = {}
) => {
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
    lastError:
      paymentIntent.last_payment_error?.message || invoice.payment?.lastError || null,
    authorizedAmount:
      minorToMajor(paymentIntent.amount) || invoice.payment?.authorizedAmount,
    capturedAmount: statusMap.markPaid
      ? minorToMajor(paymentIntent.amount_received || paymentIntent.amount)
      : undefined,
    updatedAt: new Date(),
  };
  invoice.dueAt =
    invoice.dueAt ||
    new Date(new Date(invoice.issuedAt || invoice.createdAt).getTime() + 24 * 60 * 60 * 1000);
  invoice.collections = {
    ...(invoice.collections || {}),
    state: statusMap.markPaid
      ? "RESOLVED"
      : ["REQUIRES_ACTION", "REQUIRES_PAYMENT_METHOD"].includes(
            statusMap.paymentStatus
          )
        ? "ACTION_REQUIRED"
        : invoice.collections?.state || "CURRENT",
    nextReminderAt: statusMap.markPaid
      ? undefined
      : invoice.collections?.nextReminderAt ||
        new Date(Date.now() + 60 * 60 * 1000),
  };

  await invoice.save();
  await PaymentAttempt.updateOne(
    { stripePaymentIntentId: paymentIntent.id },
    {
      $set: {
        invoice: invoice._id,
        paymentStatus: statusMap.paymentStatus,
        processorStatus: paymentIntent.status,
        declineCode: paymentIntent.last_payment_error?.code || undefined,
        failureMessage: paymentIntent.last_payment_error?.message || undefined,
        completedAt: statusMap.markPaid ? paidAt || new Date() : undefined,
      },
      $push: {
        events: {
          source,
          eventType,
          externalEventId,
          paymentStatus: statusMap.paymentStatus,
          processorStatus: paymentIntent.status,
          message: paymentIntent.last_payment_error?.message || undefined,
          occurredAt: new Date(),
        },
      },
    }
  );
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

export const refundReconciliationState = (capturedAmount, refundedAmount) => {
  const captured = roundAmount(capturedAmount);
  const refunded = roundAmount(refundedAmount);
  const fullyRefunded = captured > 0 && refunded >= captured - 0.01;
  return {
    invoiceStatus: fullyRefunded ? "REFUNDED" : "PARTIALLY_REFUNDED",
    paymentStatus: fullyRefunded ? "REFUNDED" : "PARTIALLY_REFUNDED",
    fullyRefunded,
  };
};

const reconcileRefundAccounting = async (invoice) => {
  const [summary] = await Refund.aggregate([
    { $match: { invoice: invoice._id, status: "SUCCEEDED" } },
    { $group: { _id: null, amount: { $sum: "$amount" } } },
  ]);
  const refundedAmount = roundAmount(summary?.amount || 0);
  const capturedAmount = roundAmount(
    invoice.payment?.capturedAmount || invoice.totalAmount || 0
  );
  const state = refundReconciliationState(capturedAmount, refundedAmount);

  invoice.status = state.invoiceStatus;
  invoice.payment = {
    ...(invoice.payment || {}),
    provider: "STRIPE",
    status: state.paymentStatus,
    refundedAmount,
    lastRefundAt: new Date(),
    updatedAt: new Date(),
  };
  invoice.collections = {
    ...(invoice.collections || {}),
    state: "RESOLVED",
    nextReminderAt: undefined,
  };
  await invoice.save();
  return { refundedAmount, capturedAmount, fullyRefunded: state.fullyRefunded };
};

const createRefundEarningAdjustment = async (invoice, refund) => {
  const recipient = earningRecipientForInvoice(invoice);
  if (!recipient) return null;
  const [[refundSummary], [adjustmentSummary]] = await Promise.all([
    Refund.aggregate([
      { $match: { invoice: invoice._id, status: "SUCCEEDED" } },
      { $group: { _id: null, amount: { $sum: "$amount" } } },
    ]),
    EarningTransaction.aggregate([
      {
        $match: {
          invoice: invoice._id,
          type: "ADJUSTMENT",
          refund: { $ne: refund._id },
        },
      },
      {
        $group: {
          _id: null,
          gross: { $sum: "$grossAmount" },
          fee: { $sum: "$platformFee" },
          net: { $sum: "$netAmount" },
        },
      },
    ]),
  ]);
  const ratio = Math.min(
    Number(refundSummary?.amount || 0) /
      Math.max(Number(invoice.totalAmount || 0), 0.01),
    1
  );
  const feePercent =
    invoice.platformFeePercent != null
      ? Number(invoice.platformFeePercent)
      : getPlatformFeePercent();
  const targetGross = -roundAmount(Number(invoice.subtotal || 0) * ratio);
  const targetFee = -roundAmount((Math.abs(targetGross) * feePercent) / 100);
  const targetNet = roundAmount(targetGross - targetFee);
  const grossAmount = roundAmount(targetGross - Number(adjustmentSummary?.gross || 0));
  const platformFee = roundAmount(targetFee - Number(adjustmentSummary?.fee || 0));
  const netAmount = roundAmount(targetNet - Number(adjustmentSummary?.net || 0));

  return EarningTransaction.findOneAndUpdate(
    { refund: refund._id },
    {
      $setOnInsert: {
        ...recipient,
        job: invoice.job,
        invoice: invoice._id,
        refund: refund._id,
        type: "ADJUSTMENT",
        grossAmount,
        platformFee,
        platformFeePercent: feePercent,
        netAmount,
        currency: invoice.currency || "GBP",
        paidAt: refund.processedAt || new Date(),
        notes: `Refund adjustment: ${refund.reason}`,
      },
    },
    { upsert: true, new: true }
  );
};

export const applyStripeRefundToInvoice = async (
  stripeRefund,
  { source = "WEBHOOK", initiatedBy = null, reason = null } = {}
) => {
  const paymentIntentId = stripeRefund?.payment_intent;
  if (!paymentIntentId) {
    return { ok: true, ignored: true, reason: "payment_intent_missing" };
  }

  const invoice = await Invoice.findOne({
    "payment.stripePaymentIntentId": paymentIntentId,
  });
  if (!invoice) {
    return { ok: true, ignored: true, reason: "invoice_not_found" };
  }

  const amount = minorToMajor(stripeRefund.amount);
  if (!(amount > 0)) {
    return { ok: true, ignored: true, reason: "refund_amount_missing" };
  }

  const refund = await Refund.findOneAndUpdate(
    { stripeRefundId: stripeRefund.id },
    {
      $set: {
        status:
          `${stripeRefund.status || "succeeded"}`.toLowerCase() === "succeeded"
            ? "SUCCEEDED"
            : `${stripeRefund.status || "PENDING"}`.toUpperCase(),
        failureReason: stripeRefund.failure_reason || undefined,
        processedAt:
          `${stripeRefund.status || "succeeded"}`.toLowerCase() === "succeeded"
            ? new Date()
            : undefined,
      },
      $setOnInsert: {
        invoice: invoice._id,
        job: invoice.job,
        ...(earningRecipientForInvoice(invoice) || {}),
        initiatedBy,
        provider: "STRIPE",
        stripeRefundId: stripeRefund.id,
        stripePaymentIntentId: paymentIntentId,
        amount,
        currency: invoice.currency || "GBP",
        reason:
          reason ||
          stripeRefund.metadata?.adminReason ||
          stripeRefund.reason ||
          "Stripe refund",
        source,
      },
    },
    { upsert: true, new: true }
  );

  if (refund.status !== "SUCCEEDED") {
    return {
      ok: true,
      invoiceId: invoice._id.toString(),
      refundId: refund._id.toString(),
      refundStatus: refund.status,
    };
  }

  await createRefundEarningAdjustment(invoice, refund);
  const accounting = await reconcileRefundAccounting(invoice);

  const job = await Job.findById(invoice.job);
  await createLifecycleJobEvent({
    job,
    type: "PAYMENT_REFUNDED",
    note: "Stripe charge refunded",
    payload: {
      invoiceId: invoice._id,
      stripePaymentIntentId: paymentIntentId,
      stripeRefundId: refund.stripeRefundId,
      refundedAmount: refund.amount,
      cumulativeRefundedAmount: accounting.refundedAmount,
      fullyRefunded: accounting.fullyRefunded,
    },
  });

  return {
    ok: true,
    invoiceId: invoice._id.toString(),
    paymentIntentId,
    refundId: refund._id.toString(),
    invoiceStatus: invoice.status,
    paymentStatus: invoice.payment?.status,
    refundedAmount: accounting.refundedAmount,
  };
};

const applyChargeRefundsToInvoice = async (charge) => {
  const refunds = charge?.refunds?.data || [];
  if (refunds.length) {
    let result = null;
    for (const refund of refunds) {
      result = await applyStripeRefundToInvoice(
        { ...refund, payment_intent: refund.payment_intent || charge.payment_intent },
        { source: "WEBHOOK" }
      );
    }
    return result;
  }
  return {
    ok: true,
    ignored: true,
    reason: "refund_details_missing",
    paymentIntentId: charge?.payment_intent || null,
  };
};

export const applyChargeSettlementToInvoice = async (charge) => {
  if (!charge?.payment_intent) {
    return { ok: true, ignored: true, reason: "payment_intent_missing" };
  }
  const invoice = await Invoice.findOne({
    "payment.stripePaymentIntentId": charge.payment_intent,
  });
  if (!invoice) {
    return { ok: true, ignored: true, reason: "invoice_not_found" };
  }

  invoice.payment = {
    ...(invoice.payment || {}),
    stripeChargeId: charge.id || invoice.payment?.stripeChargeId,
    stripeTransferId: charge.transfer || invoice.payment?.stripeTransferId,
    transferStatus: charge.transfer
      ? invoice.payment?.transferStatus || "CREATED"
      : invoice.payment?.transferStatus,
    transferUpdatedAt: charge.transfer ? new Date() : invoice.payment?.transferUpdatedAt,
    updatedAt: new Date(),
  };
  await invoice.save();
  return {
    ok: true,
    invoiceId: invoice._id.toString(),
    stripeChargeId: charge.id || null,
    stripeTransferId: charge.transfer || null,
  };
};

const findInvoiceForTransfer = async (transfer) => {
  let invoice = transfer?.id
    ? await Invoice.findOne({ "payment.stripeTransferId": transfer.id })
    : null;
  if (!invoice && transfer?.source_transaction) {
    invoice = await Invoice.findOne({
      "payment.stripeChargeId": transfer.source_transaction,
    });
  }
  if (!invoice && transfer?.metadata?.jobId) {
    invoice = await Invoice.findOne({ job: transfer.metadata.jobId });
  }
  return invoice;
};

export const applyTransferToInvoice = async (transfer, eventType = "transfer.updated") => {
  const invoice = await findInvoiceForTransfer(transfer);
  if (!invoice) {
    return {
      ok: true,
      ignored: true,
      reason: "invoice_not_found",
      stripeTransferId: transfer?.id || null,
    };
  }

  const failed = eventType === "transfer.failed";
  const reversed =
    eventType === "transfer.reversed" || Number(transfer?.amount_reversed || 0) > 0;
  const transferStatus = failed ? "FAILED" : reversed ? "REVERSED" : "CREATED";
  invoice.payment = {
    ...(invoice.payment || {}),
    stripeTransferId: transfer.id || invoice.payment?.stripeTransferId,
    stripeChargeId:
      transfer.source_transaction || invoice.payment?.stripeChargeId,
    transferStatus,
    transferFailureCode: failed
      ? transfer.failure_code || "transfer_failed"
      : undefined,
    transferFailureMessage: failed
      ? transfer.failure_message || "Stripe transfer failed"
      : undefined,
    transferUpdatedAt: new Date(),
    updatedAt: new Date(),
  };
  // Settlement failures never downgrade the customer's successful charge.
  await invoice.save();

  const job = await Job.findById(invoice.job);
  await createLifecycleJobEvent({
    job,
    type: "PAYMENT_UPDATED",
    note: `Stripe transfer ${transferStatus.toLowerCase()}`,
    payload: {
      invoiceId: invoice._id,
      stripeTransferId: transfer.id,
      transferStatus,
      failureCode: transfer.failure_code || null,
      failureMessage: transfer.failure_message || null,
    },
  });

  if (failed || reversed) {
    await notifyAdminsSafely({
      eventKey: ADMIN_NOTIFICATION_EVENTS.PAYMENT_FAILED,
      dedupeKey: `stripe-transfer:${transfer.id}:${transferStatus}`,
      title: `Stripe transfer ${transferStatus.toLowerCase()}`,
      body:
        transfer.failure_message ||
        `Transfer ${transfer.id} for invoice ${invoice.invoiceNo || invoice._id} requires reconciliation.`,
      data: {
        invoiceId: invoice._id.toString(),
        jobId: invoice.job?.toString?.() || null,
        stripeTransferId: transfer.id,
        transferStatus,
        screen: "ADMIN_PAYMENT",
      },
    });
  }

  return {
    ok: true,
    invoiceId: invoice._id.toString(),
    stripeTransferId: transfer.id,
    transferStatus,
    paymentStatus: invoice.payment?.status,
  };
};

export const payoutReconciliationResult = (
  payout,
  eventType,
  accountId,
  recipient = null
) => ({
  ok: true,
  payoutId: payout?.id || null,
  payoutStatus: `${
    payout?.status || eventType.split(".").at(-1) || "unknown"
  }`.toUpperCase(),
  accountId: accountId || null,
  recipientId: recipient?._id?.toString?.() || null,
  recipientRole: recipient?.role || null,
  failureCode: payout?.failure_code || null,
  failureMessage: payout?.failure_message || null,
});

const recordPayoutEvent = async (payout, eventType, accountId) => {
  const failed = eventType === "payout.failed";
  const recipient = accountId
    ? await User.findOne({
        $or: [
          { "mechanicProfile.stripeConnectAccountId": accountId },
          { "companyProfile.stripeConnectAccountId": accountId },
        ],
      })
        .select("_id role")
        .lean()
    : null;

  if (failed) {
    await notifyAdminsSafely({
      eventKey: ADMIN_NOTIFICATION_EVENTS.PAYMENT_FAILED,
      dedupeKey: `stripe-payout:${payout?.id}:FAILED`,
      title: "Stripe payout failed",
      body:
        payout?.failure_message ||
        `Payout ${payout?.id || ""} failed for Connect account ${accountId || "unknown"}.`,
      data: {
        payoutId: payout?.id || null,
        accountId: accountId || null,
        recipientId: recipient?._id?.toString?.() || null,
        recipientRole: recipient?.role || null,
        failureCode: payout?.failure_code || null,
        screen: "ADMIN_PAYMENT",
      },
    });
  }

  return payoutReconciliationResult(payout, eventType, accountId, recipient);
};

export const applyDisputeToInvoice = async (stripeDispute) => {
  const paymentIntentId = stripeDispute?.payment_intent;
  const chargeId = stripeDispute?.charge;
  if (!paymentIntentId && !chargeId) {
    return { ok: true, ignored: true, reason: "payment_reference_missing" };
  }

  const invoice = paymentIntentId
    ? await Invoice.findOne({ "payment.stripePaymentIntentId": paymentIntentId })
    : await Invoice.findOne({ "payment.stripeChargeId": chargeId });
  if (!invoice) {
    return { ok: true, ignored: true, reason: "invoice_not_found" };
  }

  const closed =
    stripeDispute?.status === "won" || stripeDispute?.status === "lost";
  invoice.payment = {
    ...(invoice.payment || {}),
    provider: "STRIPE",
    disputeStatus: stripeDispute?.status || "under_review",
    lastError: `Stripe dispute ${stripeDispute?.status || "opened"}`,
    updatedAt: new Date(),
  };
  await invoice.save();

  const job = await Job.findById(invoice.job);
  if (!job) return { ok: true, ignored: true, reason: "job_not_found" };
  const amountMinor = Number(stripeDispute?.amount || 0);
  const processorStatus = `${stripeDispute?.status || "needs_response"}`.toUpperCase();
  const canonical = await Dispute.findOneAndUpdate(
    { stripeDisputeId: stripeDispute.id },
    {
      $set: {
        processorStatus,
        stripeChargeId: chargeId || undefined,
        stripePaymentIntentId: paymentIntentId || undefined,
        stripeEvidenceDueAt: stripeDispute?.evidence_details?.due_by
          ? new Date(stripeDispute.evidence_details.due_by * 1000)
          : undefined,
        amountMinor,
        amount: minorToMajor(amountMinor),
        invoice: invoice._id,
        job: invoice.job,
        company: invoice.fleet,
        mechanic: invoice.mechanic,
        claimant: invoice.fleet,
        claimantRole: "FLEET",
        respondent: invoice.mechanic,
        respondentRole: "MECHANIC",
        financialState:
          stripeDispute?.status === "lost" ? "FULLY_ADJUSTED" : "NO_ACTION",
        status: closed ? "RESOLVED" : "OPEN",
        resolvedAt: closed ? new Date() : undefined,
      },
      $setOnInsert: {
        caseNo: `DSP-CB-${`${stripeDispute.id}`.slice(-10).toUpperCase()}`,
        caseType: "STRIPE_CHARGEBACK",
        title: `Stripe chargeback on ${invoice.invoiceNo || invoice._id}`,
        description: `Stripe reason: ${stripeDispute?.reason || "unknown"}`,
        reason: stripeDispute?.reason || "Stripe chargeback",
        reasonCode: "CHARGEBACK",
        createdBy: invoice.fleet,
        customerName: null,
        serviceLabel: job.title || job.jobCode,
        currency: `${stripeDispute?.currency || invoice.currency || "GBP"}`.toUpperCase(),
        priority: "HIGH",
        nextActionOwner: closed ? "NONE" : "ADMIN",
        responseDueAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
        decisionDueAt: stripeDispute?.evidence_details?.due_by
          ? new Date(stripeDispute.evidence_details.due_by * 1000)
          : new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      },
      $inc: { versionNumber: 1 },
    },
    { upsert: true, new: true }
  );
  await DisputeEvent.updateOne(
    {
      dispute: canonical._id,
      correlationId: `stripe-chargeback:${stripeDispute.id}:${stripeDispute?.status || "open"}`,
    },
    {
      $setOnInsert: {
        dispute: canonical._id,
        source: "STRIPE",
        type: closed ? "PROCESSOR_DECISION_RECORDED" : "PROCESSOR_STATUS_CHANGED",
        toStatus: canonical.status,
        correlationId: `stripe-chargeback:${stripeDispute.id}:${stripeDispute?.status || "open"}`,
        payload: {
          stripeDisputeId: stripeDispute.id,
          processorStatus,
          amountMinor,
          reason: stripeDispute?.reason,
        },
      },
    },
    { upsert: true }
  );

  if (stripeDispute?.status === "lost") {
    const notes = `Stripe chargeback loss ${stripeDispute.id}`;
    const recipient = earningRecipientForInvoice(invoice);
    const original = recipient
      ? await EarningTransaction.findOne({
          job: invoice.job,
          ...recipient,
          type: "JOB_PAYMENT",
        }).lean()
      : null;
    if (original) {
      await EarningTransaction.findOneAndUpdate(
        { notes },
        {
          $setOnInsert: {
            ...(recipient || {}),
            job: invoice.job,
            invoice: invoice._id,
            type: "ADJUSTMENT",
            grossAmount: -Math.abs(Number(original.grossAmount || 0)),
            platformFee: -Math.abs(Number(original.platformFee || 0)),
            platformFeePercent: original.platformFeePercent,
            netAmount: -Math.abs(Number(original.netAmount || 0)),
            currency: invoice.currency || "GBP",
            paidAt: new Date(),
            notes,
          },
        },
        { upsert: true, new: true }
      );
    }
    await DisputeFinancialAction.findOneAndUpdate(
      { idempotencyKey: `stripe-chargeback:${stripeDispute.id}:lost` },
      {
        $setOnInsert: {
          dispute: canonical._id,
          invoice: invoice._id,
          requestedBy: invoice.fleet,
          type: "CHARGEBACK_ADJUSTMENT",
          amountMinor,
          currency: invoice.currency || "GBP",
          status: "SUCCEEDED",
          idempotencyKey: `stripe-chargeback:${stripeDispute.id}:lost`,
          processedAt: new Date(),
        },
      },
      { upsert: true }
    );
  }

  await createLifecycleJobEvent({
    job,
    type: "PAYMENT_DISPUTED",
    note: `Stripe dispute ${stripeDispute?.status || "opened"}`,
    payload: {
      invoiceId: invoice._id,
      stripePaymentIntentId: paymentIntentId || null,
      disputeStatus: stripeDispute?.status || null,
      disputeId: canonical._id,
    },
  });

  await notifyAdminsSafely({
    eventKey: ADMIN_NOTIFICATION_EVENTS.PAYMENT_FAILED,
    dedupeKey: `payment-dispute:${stripeDispute?.id || invoice._id}:${stripeDispute?.status || "open"}`,
    title: `Chargeback ${stripeDispute?.status || "opened"} on invoice ${invoice.invoiceNo || invoice._id}`,
    body: `A Stripe dispute is ${stripeDispute?.status || "open"} for payment ${paymentIntentId || ""}.`,
    data: {
      disputeId: canonical._id.toString(),
      invoiceId: invoice._id.toString(),
      jobId: invoice.job?.toString?.() || null,
      paymentIntentId: paymentIntentId || null,
      screen: "ADMIN_DISPUTE",
    },
  });

  return {
    ok: true,
    invoiceId: invoice._id.toString(),
    disputeId: canonical._id.toString(),
    disputeStatus: stripeDispute?.status || null,
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
      return applyPaymentIntentToInvoice(event.data?.object || {}, {
        source: "WEBHOOK",
        eventType: event.type,
        externalEventId: event.id,
      });
    case "charge.refunded":
      return applyChargeRefundsToInvoice(event.data?.object || {});
    case "charge.succeeded":
    case "charge.updated":
      return applyChargeSettlementToInvoice(event.data?.object || {});
    case "refund.created":
    case "refund.updated":
    case "refund.failed":
      return applyStripeRefundToInvoice(event.data?.object || {}, {
        source: "WEBHOOK",
      });
    case "charge.dispute.created":
    case "charge.dispute.updated":
    case "charge.dispute.closed":
      return applyDisputeToInvoice(event.data?.object || {});
    case "account.updated":
      return syncStripeConnectAccountFromWebhook(event.data?.object || {});
    case "capability.updated": {
      const accountId =
        event.account || event.data?.object?.account || event.data?.object?.account_id;
      if (!accountId) {
        return { ok: true, ignored: true, reason: "connect_account_missing" };
      }
      const account = await retrieveStripeConnectAccount(accountId);
      return syncStripeConnectAccountFromWebhook(account);
    }
    case "transfer.created":
    case "transfer.updated":
    case "transfer.reversed":
      return applyTransferToInvoice(event.data?.object || {}, event.type);
    case "payout.created":
    case "payout.updated":
    case "payout.paid":
    case "payout.failed":
    case "payout.canceled":
    case "payout.reconciliation_completed":
      return recordPayoutEvent(
        event.data?.object || {},
        event.type,
        event.account || null
      );
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
      await StripeWebhookEvent.create({
        eventId: event.id,
        type: event.type,
        accountId: event.account || undefined,
        objectId: event.data?.object?.id || undefined,
      });
    } catch (err) {
      if (err?.code === 11000) {
        return { ok: true, ignored: true, reason: "duplicate_event", eventId: event.id };
      }
      throw err;
    }
  }

  let dispatched = false;
  try {
    const result = await dispatchStripeEvent(event);
    dispatched = true;
    if (event.id) {
      await StripeWebhookEvent.updateOne(
        { eventId: event.id },
        {
          $set: {
            status: "PROCESSED",
            result,
            processedAt: new Date(),
          },
        }
      );
    }
    return result;
  } catch (err) {
    // A failed handler must be retryable. If only the final ledger update
    // failed, keep the claim: business side effects already completed and
    // replaying them would violate webhook idempotency.
    if (event.id && !dispatched) {
      await StripeWebhookEvent.deleteOne({ eventId: event.id });
    }
    throw err;
  }
};
