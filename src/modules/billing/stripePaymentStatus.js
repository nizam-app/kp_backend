/**
 * Pure mapping helpers for Stripe PaymentIntent status → invoice/payment state.
 * Kept dependency-free so it can be unit-tested in isolation and shared between
 * the synchronous approval path and the asynchronous webhook path.
 */

/** Payment states protected from stale, out-of-order processor events. */
export const TERMINAL_PAID_STATUSES = new Set(["SUCCEEDED"]);
export const TERMINAL_PAYMENT_STATUSES = new Set([
  "SUCCEEDED",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
]);

export const invoiceStatusFromPaymentIntent = (status) => {
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

/**
 * True when an incoming event must be ignored because it would downgrade an
 * already-confirmed payment (protects against out-of-order webhook delivery).
 */
export const shouldSkipDowngrade = (previousPaymentStatus, statusMap) =>
  ["PARTIALLY_REFUNDED", "REFUNDED"].includes(previousPaymentStatus) ||
  (TERMINAL_PAID_STATUSES.has(previousPaymentStatus) && !statusMap.markPaid);

/**
 * True when a signature timestamp is outside the replay-tolerance window.
 * `nowSeconds` and `timestampSeconds` are unix seconds.
 */
export const isWebhookTimestampExpired = (
  timestampSeconds,
  nowSeconds,
  toleranceSeconds
) =>
  Number.isFinite(timestampSeconds) &&
  Number.isFinite(toleranceSeconds) &&
  toleranceSeconds > 0 &&
  Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds;
