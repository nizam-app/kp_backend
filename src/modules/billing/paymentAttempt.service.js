import crypto from "crypto";

const intentPaymentMethodId = (paymentIntent) => {
  const method = paymentIntent?.payment_method;
  return typeof method === "string" ? method : method?.id || null;
};

export const normalizeApprovalRequestId = (value) => {
  const requestId = `${value || ""}`.trim();
  if (!requestId) return crypto.randomUUID();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) return null;
  return requestId;
};

export const paymentAttemptId = (existingAttempt, approvalRequestId) =>
  existingAttempt?.attemptId ||
  existingAttempt?._id?.toString?.() ||
  approvalRequestId ||
  crypto.randomUUID();

export const hasProcessedApprovalRequest = (attempt, approvalRequestId) =>
  Boolean(
    approvalRequestId &&
      attempt?.events?.some(
        (event) =>
          event?.source === "APPROVAL" &&
          event?.externalEventId === approvalRequestId
      )
  );

const processedApprovalEvent = (attempt, approvalRequestId) =>
  attempt?.events?.find(
    (event) =>
      event?.source === "APPROVAL" &&
      event?.externalEventId === approvalRequestId
  );

/**
 * Decide the next Stripe operation without weakening the one-payment-per-job
 * guard. A non-reusable intent must be canceled before CREATE_NEW is allowed.
 */
export const planStripePaymentIntentRetry = ({
  paymentIntent,
  existingAttempt,
  paymentMethodId,
  approvalRequestId,
  amountMinor,
  currency,
  customerId,
  recipientConnectAccountId,
  platformFeeMinor,
}) => {
  if (!paymentIntent) return "CREATE_NEW";
  const processedEvent = processedApprovalEvent(
    existingAttempt,
    approvalRequestId
  );
  if (
    processedEvent?.stripePaymentMethodId &&
    processedEvent.stripePaymentMethodId !== paymentMethodId
  ) {
    return "REQUEST_CONFLICT";
  }
  if (processedEvent) {
    return "RETURN_EXISTING";
  }

  const requestParametersChanged =
    (Number.isFinite(amountMinor) && paymentIntent.amount !== amountMinor) ||
    (currency &&
      `${paymentIntent.currency || ""}`.toLowerCase() !==
        `${currency}`.toLowerCase()) ||
    (customerId &&
      `${paymentIntent.customer?.id || paymentIntent.customer || ""}` !==
        `${customerId}`) ||
    (recipientConnectAccountId &&
      `${
        paymentIntent.transfer_data?.destination?.id ||
        paymentIntent.transfer_data?.destination ||
        ""
      }` !== `${recipientConnectAccountId}`) ||
    (Number.isFinite(platformFeeMinor) &&
      paymentIntent.application_fee_amount !== platformFeeMinor);

  switch (paymentIntent.status) {
    case "succeeded":
      return "RETURN_EXISTING";
    case "processing":
      return requestParametersChanged ? "CONFLICT" : "RETURN_EXISTING";
    case "requires_payment_method":
    case "requires_confirmation":
      return requestParametersChanged
        ? "CANCEL_THEN_CREATE"
        : "CONFIRM_EXISTING";
    case "requires_action":
      return !requestParametersChanged &&
        intentPaymentMethodId(paymentIntent) === paymentMethodId
        ? "RETURN_EXISTING"
        : "CANCEL_THEN_CREATE";
    case "canceled":
      return "CREATE_NEW";
    default:
      return "CONFLICT";
  }
};

export const buildPaymentAttemptUpsert = ({
  job,
  payer,
  payerRole,
  amount,
  currency,
  paymentIntent,
  paymentMethodId,
  attemptId,
  createIdempotencyKey,
  operationIdempotencyKey,
  approvalRequestId,
  paymentStatus,
  paid,
  eventType,
}) => {
  const declineCode = paymentIntent.last_payment_error?.code;
  const failureMessage = paymentIntent.last_payment_error?.message;
  const update = {
    $set: {
    paymentStatus,
    processorStatus: paymentIntent.status,
    // This path intentionally appears in one operator only. MongoDB rejects
    // an upsert that writes the same path through $set and $setOnInsert.
    stripePaymentMethodId: paymentMethodId,
    completedAt: paid ? new Date() : undefined,
    ...(declineCode ? { declineCode } : {}),
    ...(failureMessage ? { failureMessage } : {}),
    },
    $setOnInsert: {
    job,
    payer,
    payerRole,
    provider: "STRIPE",
    attemptId,
    amount,
    currency,
    stripePaymentIntentId: paymentIntent.id,
    idempotencyKey: createIdempotencyKey,
    },
    $push: {
    events: {
      source: "APPROVAL",
      eventType,
      externalEventId: approvalRequestId,
      idempotencyKey: operationIdempotencyKey,
      stripePaymentMethodId: paymentMethodId,
      paymentStatus,
      processorStatus: paymentIntent.status,
      message: failureMessage || undefined,
      occurredAt: new Date(),
    },
    },
  };

  if (!declineCode && !failureMessage) {
    update.$unset = { declineCode: 1, failureMessage: 1 };
  }
  return update;
};
