/**
 * Company “earnings” helpers — platform fee on job bill (ex-VAT gross).
 * Fee percent comes from PlatformSettings cache (default 12%).
 */
import {
  computePlatformFee,
  computePlatformFeeNet,
  getPlatformFeePercent,
} from "./platformFee.js";

export const companyEarningsGross = (job, invoice = null) => {
  const fromJob = Number(job?.finalAmount ?? job?.acceptedAmount ?? job?.estimatedPayout ?? 0);
  if (Number.isFinite(fromJob) && fromJob > 0) return fromJob;
  const fromInvoice = Number(invoice?.subtotal ?? invoice?.totalAmount ?? 0);
  if (Number.isFinite(fromInvoice) && fromInvoice > 0) return fromInvoice;
  return 0;
};

export const companyEarningsPlatformFee = (gross) => computePlatformFee(gross);

export const companyEarningsNet = (gross) => {
  const { netAmount } = computePlatformFeeNet(gross);
  return netAmount;
};

export const companyEarningsBreakdown = (job, invoice = null) => {
  const grossAmount = companyEarningsGross(job, invoice);
  const breakdown = computePlatformFeeNet(grossAmount);
  return {
    platformFeePercent: breakdown.platformFeePercent || getPlatformFeePercent(),
    grossAmount: breakdown.grossAmount,
    platformFeeAmount: breakdown.platformFee,
    netAmount: breakdown.netAmount,
    currency: job?.currency || invoice?.currency || "GBP",
  };
};
