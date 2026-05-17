import AppError from "../../utils/AppError.js";
import { EarningTransaction } from "./earningTransaction.model.js";
import { Invoice } from "../invoice/invoice.model.js";
import { User } from "../user/user.model.js";
import { Review } from "../review/review.model.js";

const parsePage = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
};

const parseLimit = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(Math.floor(n), 100);
};

const getMonthRange = (date = new Date()) => {
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 1);
  return { start, end };
};

const getDayRange = (date = new Date()) => {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  return { start, end };
};

const monthLabel = (date) =>
  date.toLocaleString("en-US", { month: "short", year: "numeric" });

const roundMoney = (value) =>
  Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

const formatDayMonthYear = (value) => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};

const currencySymbol = (currency) => {
  const c = `${currency || "GBP"}`.toUpperCase();
  if (c === "GBP") return "£";
  if (c === "EUR") return "€";
  if (c === "USD") return "$";
  if (c === "ZAR") return "R";
  return `${c} `;
};

const moneyLabel = (amount, currency = "GBP") =>
  `${currencySymbol(currency)}${roundMoney(amount)}`;

const buildVehicleLine = (job) => {
  const v = job?.vehicle;
  if (!v) return null;
  const type = `${v.type || ""}`.trim();
  const reg = `${v.registration || ""}`.trim();
  if (type && reg) return `${type} · ${reg}`;
  if (type) return type;
  if (reg) return reg;
  const mk = [v.make, v.model].filter(Boolean).join(" ").trim();
  return mk || null;
};

const formatJobDurationLabel = (job) => {
  if (!job?.completedAt) return null;
  const start = job.assignedAt || job.postedAt || job.createdAt;
  if (!start) return null;
  const ms = Math.max(new Date(job.completedAt).getTime() - new Date(start).getTime(), 0);
  const mins = Math.round(ms / 60000);
  if (!Number.isFinite(mins) || mins <= 0) return null;
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
};

/** Fleet review left on the job (for earnings / invoice UIs). */
const serializeEarningReview = (review) =>
  review
    ? {
        _id: review._id,
        rating: review.rating,
        comment: review.comment ?? null,
        companyName: review.companyName ?? null,
        customerName: review.customerName ?? null,
        serviceLabel: review.serviceLabel ?? null,
        mechanicName: review.mechanicName ?? null,
        status: review.status ?? null,
        createdAt: review.createdAt ?? null,
      }
    : null;

const ensureMechanic = (user) => {
  if (user.role !== "MECHANIC") {
    throw new AppError("Only mechanics can access earnings", 403);
  }
};

export const getEarningsSummary = async (user) => {
  ensureMechanic(user);

  const now = new Date();
  const { start: monthStart, end: monthEnd } = getMonthRange(now);
  const { start: dayStart, end: dayEnd } = getDayRange(now);
  const seriesStart = new Date(now.getFullYear(), now.getMonth() - 5, 1);

  const [todayAgg, monthAgg, allTimeAgg, monthSeriesAgg, earliestTx] = await Promise.all([
    EarningTransaction.aggregate([
      {
        $match: {
          mechanic: user._id,
          paidAt: { $gte: dayStart, $lt: dayEnd },
        },
      },
      {
        $group: {
          _id: null,
          gross: { $sum: "$grossAmount" },
          net: { $sum: "$netAmount" },
        },
      },
    ]),
    EarningTransaction.aggregate([
      {
        $match: {
          mechanic: user._id,
          paidAt: { $gte: monthStart, $lt: monthEnd },
        },
      },
      {
        $group: {
          _id: null,
          gross: { $sum: "$grossAmount" },
          net: { $sum: "$netAmount" },
        },
      },
    ]),
    EarningTransaction.aggregate([
      { $match: { mechanic: user._id } },
      {
        $group: {
          _id: null,
          gross: { $sum: "$grossAmount" },
          net: { $sum: "$netAmount" },
        },
      },
    ]),
    EarningTransaction.aggregate([
      {
        $match: {
          mechanic: user._id,
          paidAt: { $gte: seriesStart },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: "$paidAt" },
            month: { $month: "$paidAt" },
          },
          net: { $sum: "$netAmount" },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]),
    EarningTransaction.findOne({ mechanic: user._id }).sort({ paidAt: 1 }).select("paidAt").lean(),
  ]);

  const today = todayAgg[0] || { gross: 0, net: 0 };
  const month = monthAgg[0] || { gross: 0, net: 0 };
  const allTime = allTimeAgg[0] || { gross: 0, net: 0 };
  const monthPlatformFee = Math.max(roundMoney(month.gross - month.net), 0);
  const allTimePlatformFee = Math.max(roundMoney(allTime.gross - allTime.net), 0);
  const currency = "GBP";

  const monthMap = new Map(
    monthSeriesAgg.map((item) => [
      `${item._id.year}-${item._id.month}`,
      roundMoney(item.net),
    ])
  );

  const monthlyNetSeries = Array.from({ length: 6 }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - (5 - index), 1);
    const key = `${date.getFullYear()}-${date.getMonth() + 1}`;
    const net = monthMap.get(key) || 0;
    const isCurrentMonth =
      date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
    return {
      monthShort: date.toLocaleString("en-GB", { month: "short" }),
      label: monthLabel(date),
      month: date.getMonth() + 1,
      year: date.getFullYear(),
      net,
      netChartApproxLabel: net >= 1000 ? `${(net / 1000).toFixed(1)}k` : String(Math.round(net)),
      isCurrentMonth,
    };
  });

  const monthShort = now.toLocaleString("en-GB", { month: "short" });

  return {
    meta: {
      platformFeePercent: 12,
      currency,
      monthlyChartFootnote: "12% platform fee already deducted from net figures.",
    },
    period: {
      monthShort,
      monthLong: now.toLocaleString("en-GB", { month: "long" }),
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      monthRangeStart: monthStart,
      monthRangeEndExclusive: monthEnd,
      allTimeSinceLabel: earliestTx?.paidAt
        ? `Net since ${formatDayMonthYear(earliestTx.paidAt)}`
        : "Net since you started",
    },
    cards: {
      todayGross: roundMoney(today.gross),
      todayNet: roundMoney(today.net),
      monthGross: roundMoney(month.gross),
      monthNet: roundMoney(month.net),
      monthPlatformFee,
      monthPlatformFeeLabel: moneyLabel(monthPlatformFee, currency),
      allTimeGross: roundMoney(allTime.gross),
      allTimeNet: roundMoney(allTime.net),
      allTimePlatformFee,
      /** Card titles matching common mechanic UI copy */
      labels: {
        monthGrossCard: `${monthShort} Gross`,
        monthGrossSub: "Before platform fee",
        monthNetCard: `${monthShort} Net`,
        monthNetSub: "After 12% fee",
        allTimeNetCard: "All-time",
        allTimeNetSub: earliestTx?.paidAt
          ? `Net since ${formatDayMonthYear(earliestTx.paidAt)}`
          : "Net since you started",
      },
      /** Convenience for UIs that label “before / after fee” like the mechanic earnings screen. */
      platformFeePercent: 12,
    },
    monthlyNetSeries,
  };
};

/** Full invoice payload for earnings / tax-invoice style UIs */
const serializeInvoiceForEarnings = (invoice, currencyFallback) => {
  if (!invoice) return null;
  const cur = invoice.currency || currencyFallback || "GBP";
  const idStr = invoice._id?.toString?.();
  return {
    _id: invoice._id,
    invoiceNo: invoice.invoiceNo,
    pdfUrl: invoice.pdfUrl || null,
    subtotal: invoice.subtotal != null ? roundMoney(invoice.subtotal) : null,
    vatAmount: invoice.vatAmount != null ? roundMoney(invoice.vatAmount) : null,
    totalAmount: invoice.totalAmount != null ? roundMoney(invoice.totalAmount) : null,
    currency: cur,
    status: invoice.status || null,
    issuedAt: invoice.issuedAt || null,
    paidAt: invoice.paidAt || null,
    payment: invoice.payment
      ? {
          provider: invoice.payment.provider || null,
          status: invoice.payment.status || null,
          stripePaymentIntentId: invoice.payment.stripePaymentIntentId || null,
          stripePaymentMethodId: invoice.payment.stripePaymentMethodId || null,
          stripeClientSecret: invoice.payment.stripeClientSecret || null,
          lastError: invoice.payment.lastError || null,
          authorizedAmount: invoice.payment.authorizedAmount ?? null,
          capturedAmount: invoice.payment.capturedAmount ?? null,
          updatedAt: invoice.payment.updatedAt || null,
        }
      : null,
    lineItems: (invoice.lineItems || []).map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unitAmount: line.unitAmount != null ? roundMoney(line.unitAmount) : null,
      totalAmount: line.totalAmount != null ? roundMoney(line.totalAmount) : null,
    })),
    billedToSnapshot: invoice.billedToSnapshot || null,
    mechanicSnapshot: invoice.mechanicSnapshot || null,
    createdAt: invoice.createdAt || null,
    updatedAt: invoice.updatedAt || null,
    downloadPath: idStr ? `/api/v1/invoices/${idStr}/download` : null,
    issuedAtLabel: formatDayMonthYear(invoice.issuedAt),
    paidAtLabel: formatDayMonthYear(invoice.paidAt),
  };
};

export const listEarningJobs = async (user, query = {}) => {
  ensureMechanic(user);

  const page = parsePage(query.page);
  const limit = parseLimit(query.limit);
  const skip = (page - 1) * limit;

  const [transactions, total] = await Promise.all([
    EarningTransaction.find({ mechanic: user._id })
      .sort({ paidAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate({
        path: "job",
        select:
          "jobCode title description completionSummary vehicle completedAt fleet assignedAt postedAt createdAt location",
        populate: { path: "fleet", select: "fleetProfile.companyName fleetProfile.contactName email" },
      })
      .populate("mechanic", "mechanicProfile.displayName")
      .lean(),
    EarningTransaction.countDocuments({ mechanic: user._id }),
  ]);

  const jobIds = transactions
    .map((item) => item.job?._id || item.job)
    .filter(Boolean);

  const invoices = await Invoice.find({
    mechanic: user._id,
    job: { $in: jobIds },
  })
    .select(
      "_id job invoiceNo pdfUrl lineItems subtotal vatAmount totalAmount currency issuedAt paidAt status payment billedToSnapshot mechanicSnapshot createdAt updatedAt"
    )
    .lean();

  const invoiceByJobId = new Map(
    invoices.map((invoice) => [invoice.job.toString(), invoice])
  );

  const reviews = await Review.find({ job: { $in: jobIds } })
    .select("job rating comment createdAt companyName customerName serviceLabel mechanicName status")
    .lean();
  const reviewByJobId = new Map(reviews.map((r) => [String(r.job), r]));

  return {
    items: transactions.map((item) => {
      const jobIdStr = (item.job?._id || item.job)?.toString();
      const invoice = jobIdStr ? invoiceByJobId.get(jobIdStr) : undefined;
      const review = jobIdStr ? reviewByJobId.get(jobIdStr) : undefined;
      const cur = item.currency || invoice?.currency || "GBP";
      const gross = roundMoney(item.grossAmount);
      const fee = roundMoney(item.platformFee);
      const net = roundMoney(item.netAmount);
      const feeWhole = Math.round(fee);
      const completedAt = item.job?.completedAt || null;
      const paidAt = item.paidAt || null;
      const vehicleLine = buildVehicleLine(item.job);
      const issueSummary =
        item.job?.completionSummary || item.job?.description || item.job?.title || null;
      const customerName =
        review?.companyName ||
        item.job?.fleet?.fleetProfile?.companyName ||
        item.job?.fleet?.fleetProfile?.contactName ||
        item.job?.fleet?.email ||
        null;
      const fleetContactName = item.job?.fleet?.fleetProfile?.contactName || null;
      const locationAddress = item.job?.location?.address || null;

      return {
        _id: item._id,
        type: item.type,
        grossAmount: gross,
        platformFee: fee,
        netAmount: net,
        platformFeePercent: 12,
        currency: cur,
        paidAt,
        notes: item.notes || null,
        job: {
          _id: item.job?._id || item.job,
          jobCode: item.job?.jobCode || null,
          title: item.job?.title || null,
          description: item.job?.description || null,
          completionSummary: item.job?.completionSummary || null,
          issueSummary,
          vehicleRegistration: item.job?.vehicle?.registration || null,
          vehicleType: item.job?.vehicle?.type || null,
          vehicleMake: item.job?.vehicle?.make || null,
          vehicleModel: item.job?.vehicle?.model || null,
          vehicleDisplay: vehicleLine,
          completedAt,
          completedAtLabel: formatDayMonthYear(completedAt),
          paidAtLabel: formatDayMonthYear(paidAt),
          assignedAt: item.job?.assignedAt || null,
          postedAt: item.job?.postedAt || null,
          createdAt: item.job?.createdAt || null,
          customerName,
          fleetContactName,
          fleetEmail: item.job?.fleet?.email || null,
          locationAddress,
          durationLabel: formatJobDurationLabel(item.job),
          rating: review?.rating ?? null,
        },
        review: serializeEarningReview(review),
        invoice: serializeInvoiceForEarnings(invoice, cur),
        /** Pre-formatted strings & grouped numbers for mobile “Earnings & Invoices” screens */
        ui: {
          jobCode: item.job?.jobCode || null,
          headlineDateLabel: formatDayMonthYear(completedAt || paidAt),
          paidDateLabel: formatDayMonthYear(paidAt),
          completedDateLabel: formatDayMonthYear(completedAt),
          vehicleLine,
          issueLine: issueSummary,
          customerName,
          fleetContactName,
          locationAddress,
          durationLabel: formatJobDurationLabel(item.job),
          rating: review?.rating ?? null,
          currency: cur,
          netEarnedLabel: moneyLabel(net, cur),
          grossLabel: moneyLabel(gross, cur),
          platformFeeLabel: `-${moneyLabel(fee, cur)}`,
          platformFeeWholeLabel: `-${currencySymbol(cur)}${feeWhole}`,
          netLabel: moneyLabel(net, cur),
          breakdown: {
            grossAmount: gross,
            platformFeePercent: 12,
            platformFeeAmount: fee,
            netAmount: net,
            currency: cur,
          },
          primaryAction: invoice
            ? {
                key: "VIEW_INVOICE",
                label: "View Invoice",
                method: "GET",
                path: `/api/v1/invoices/${invoice._id.toString()}/download`,
              }
            : null,
        },
      };
    }),
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
};

/** Stripe Connect + platform fee metadata for mechanic earnings UI */
export const getPayoutInfo = async (user) => {
  ensureMechanic(user);

  const fresh = await User.findById(user._id)
    .select(
      "mechanicProfile.stripeConnectAccountId mechanicProfile.stripeConnectOnboardingComplete mechanicProfile.stripeConnectPayoutsEnabled mechanicProfile.stripeConnectChargesEnabled"
    )
    .lean();

  const mp = fresh?.mechanicProfile || {};

  return {
    platformFeePercent: 12,
    currency: "GBP",
    stripe: {
      connectAccountId: mp.stripeConnectAccountId || null,
      onboardingComplete: !!mp.stripeConnectOnboardingComplete,
      chargesEnabled: !!mp.stripeConnectChargesEnabled,
      payoutsEnabled: !!mp.stripeConnectPayoutsEnabled,
    },
    notes:
      "Net job earnings are credited after fleet payment clears; schedules follow Stripe Connect payout settings.",
  };
};

/** Monthly breakdown for tax / statements UI */
export const getEarningsStatement = async (user, query = {}) => {
  ensureMechanic(user);

  const year = Math.min(
    2099,
    Math.max(2020, Number.parseInt(query.year, 10) || new Date().getFullYear())
  );
  const month =
    Math.min(12, Math.max(1, Number.parseInt(query.month, 10) || new Date().getMonth() + 1)) - 1;

  const start = new Date(year, month, 1);
  const end = new Date(year, month + 1, 1);

  const txs = await EarningTransaction.find({
    mechanic: user._id,
    paidAt: { $gte: start, $lt: end },
  })
    .sort({ paidAt: -1 })
    .populate({
      path: "job",
      select:
        "jobCode title description completionSummary vehicle completedAt fleet assignedAt postedAt createdAt location",
      populate: { path: "fleet", select: "fleetProfile.companyName fleetProfile.contactName email" },
    })
    .lean();

  const totals = txs.reduce(
    (acc, t) => {
      acc.gross += Number(t.grossAmount) || 0;
      acc.platformFee += Number(t.platformFee) || 0;
      acc.net += Number(t.netAmount) || 0;
      return acc;
    },
    { gross: 0, platformFee: 0, net: 0 }
  );

  const stmtJobIds = txs.map((t) => t.job?._id || t.job).filter(Boolean);
  const stmtInvoices = await Invoice.find({ mechanic: user._id, job: { $in: stmtJobIds } })
    .select(
      "_id job invoiceNo pdfUrl lineItems subtotal vatAmount totalAmount currency issuedAt paidAt status payment billedToSnapshot mechanicSnapshot createdAt updatedAt"
    )
    .lean();
  const stmtInvoiceByJobId = new Map(stmtInvoices.map((inv) => [inv.job.toString(), inv]));

  const stmtReviews = await Review.find({ job: { $in: stmtJobIds } })
    .select("job rating comment createdAt companyName customerName serviceLabel mechanicName status")
    .lean();
  const stmtReviewByJobId = new Map(stmtReviews.map((r) => [String(r.job), r]));

  const cur = txs[0]?.currency || "GBP";

  return {
    period: {
      year,
      month: month + 1,
      label: start.toLocaleString("en-GB", { month: "long", year: "numeric" }),
      start,
      end,
    },
    meta: {
      platformFeePercent: 12,
      currency: cur,
    },
    currency: cur,
    totals: {
      gross: roundMoney(totals.gross),
      platformFee: roundMoney(totals.platformFee),
      net: roundMoney(totals.net),
    },
    lineItems: txs.map((t) => {
      const jid = t.job?._id || t.job;
      const jidStr = jid ? String(jid) : "";
      const rev = jidStr ? stmtReviewByJobId.get(jidStr) : undefined;
      const inv = jidStr ? stmtInvoiceByJobId.get(jidStr) : undefined;
      const gross = roundMoney(t.grossAmount);
      const fee = roundMoney(t.platformFee);
      const net = roundMoney(t.netAmount);
      const feeWhole = Math.round(fee);
      const job = t.job;
      const vehicleLine = buildVehicleLine(job);
      const issueSummary = job?.completionSummary || job?.description || job?.title || null;
      const customerName =
        rev?.companyName ||
        job?.fleet?.fleetProfile?.companyName ||
        job?.fleet?.fleetProfile?.contactName ||
        job?.fleet?.email ||
        null;

      return {
        _id: t._id,
        paidAt: t.paidAt,
        paidAtLabel: formatDayMonthYear(t.paidAt),
        grossAmount: gross,
        platformFee: fee,
        netAmount: net,
        platformFeePercent: 12,
        currency: t.currency || cur,
        review: serializeEarningReview(rev),
        invoice: serializeInvoiceForEarnings(inv, t.currency || cur),
        job: job
          ? {
              _id: job._id,
              jobCode: job.jobCode,
              title: job.title,
              description: job.description || null,
              completionSummary: job.completionSummary || null,
              issueSummary,
              completedAt: job.completedAt || null,
              completedAtLabel: formatDayMonthYear(job.completedAt),
              vehicleRegistration: job.vehicle?.registration || null,
              vehicleType: job.vehicle?.type || null,
              vehicleMake: job.vehicle?.make || null,
              vehicleModel: job.vehicle?.model || null,
              vehicleDisplay: vehicleLine,
              customerName,
              fleetContactName: job.fleet?.fleetProfile?.contactName || null,
              locationAddress: job.location?.address || null,
              durationLabel: formatJobDurationLabel(job),
              rating: rev?.rating ?? null,
            }
          : null,
        ui: {
          jobCode: job?.jobCode || null,
          headlineDateLabel: formatDayMonthYear(job?.completedAt || t.paidAt),
          vehicleLine,
          issueLine: issueSummary,
          customerName,
          durationLabel: formatJobDurationLabel(job),
          rating: rev?.rating ?? null,
          netEarnedLabel: moneyLabel(net, t.currency || cur),
          grossLabel: moneyLabel(gross, t.currency || cur),
          platformFeeLabel: `-${moneyLabel(fee, t.currency || cur)}`,
          platformFeeWholeLabel: `-${currencySymbol(t.currency || cur)}${feeWhole}`,
          netLabel: moneyLabel(net, t.currency || cur),
          primaryAction: inv
            ? {
                key: "VIEW_INVOICE",
                label: "View Invoice",
                method: "GET",
                path: `/api/v1/invoices/${inv._id.toString()}/download`,
              }
            : null,
        },
      };
    }),
  };
};

/**
 * One response for the mechanic “Earnings & Invoices” screen: summary + chart + job rows + payout metadata.
 * Query: `jobsPage`, `jobsLimit` (same semantics as `GET /earnings/jobs`; defaults page=1, limit=20).
 */
export const getEarningsOverview = async (user, query = {}) => {
  ensureMechanic(user);
  const jobsQuery = {
    page: query.jobsPage ?? query.page,
    limit: query.jobsLimit ?? query.limit,
  };
  const [summary, jobs, payout] = await Promise.all([
    getEarningsSummary(user),
    listEarningJobs(user, jobsQuery),
    getPayoutInfo(user),
  ]);
  return { summary, jobs, payout };
};
