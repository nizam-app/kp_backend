/**
 * Single source of truth for company “earnings” (12% platform fee on job bill).
 * Used by company earnings list/summary and company-facing invoice breakdowns.
 */

export const companyEarningsGross = (job, invoice = null) => {
  const fromJob = Number(job?.finalAmount ?? job?.acceptedAmount ?? job?.estimatedPayout ?? 0);
  if (Number.isFinite(fromJob) && fromJob > 0) return fromJob;
  const fromInvoice = Number(invoice?.subtotal ?? invoice?.totalAmount ?? 0);
  if (Number.isFinite(fromInvoice) && fromInvoice > 0) return fromInvoice;
  return 0;
};

export const companyEarningsPlatformFee = (gross) =>
  Math.round(Math.max(Number(gross) || 0, 0) * 0.12 * 100) / 100;

export const companyEarningsNet = (gross) => {
  const g = Math.max(Number(gross) || 0, 0);
  const fee = companyEarningsPlatformFee(g);
  return Math.max(Math.round((g - fee) * 100) / 100, 0);
};

export const companyEarningsBreakdown = (job, invoice = null) => {
  const grossAmount = companyEarningsGross(job, invoice);
  const platformFeeAmount = companyEarningsPlatformFee(grossAmount);
  const netAmount = companyEarningsNet(grossAmount);
  return {
    platformFeePercent: 12,
    grossAmount,
    platformFeeAmount,
    netAmount,
    currency: job?.currency || invoice?.currency || "GBP",
  };
};
