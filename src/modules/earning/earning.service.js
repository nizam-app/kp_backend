import AppError from "../../utils/AppError.js";
import { EarningTransaction } from "./earningTransaction.model.js";
import { Invoice } from "../invoice/invoice.model.js";
import { User } from "../user/user.model.js";

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

  const [todayAgg, monthAgg, allTimeAgg, monthSeriesAgg] = await Promise.all([
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
  ]);

  const today = todayAgg[0] || { gross: 0, net: 0 };
  const month = monthAgg[0] || { gross: 0, net: 0 };
  const allTime = allTimeAgg[0] || { gross: 0, net: 0 };

  const monthMap = new Map(
    monthSeriesAgg.map((item) => [
      `${item._id.year}-${item._id.month}`,
      item.net,
    ])
  );

  const monthlyNetSeries = Array.from({ length: 6 }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - (5 - index), 1);
    const key = `${date.getFullYear()}-${date.getMonth() + 1}`;
    return {
      label: monthLabel(date),
      month: date.getMonth() + 1,
      year: date.getFullYear(),
      net: monthMap.get(key) || 0,
    };
  });

  return {
    cards: {
      todayGross: today.gross,
      monthGross: month.gross,
      monthNet: month.net,
      allTimeNet: allTime.net,
    },
    monthlyNetSeries,
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
      .populate(
        "job",
        "jobCode title description completionSummary vehicle completedAt fleet"
      )
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
    .select("_id job invoiceNo pdfUrl")
    .lean();

  const invoiceByJobId = new Map(
    invoices.map((invoice) => [invoice.job.toString(), invoice])
  );

  return {
    items: transactions.map((item) => {
      const invoice = invoiceByJobId.get((item.job?._id || item.job)?.toString());
      return {
        _id: item._id,
        type: item.type,
        grossAmount: item.grossAmount,
        platformFee: item.platformFee,
        netAmount: item.netAmount,
        currency: item.currency,
        paidAt: item.paidAt,
        notes: item.notes || null,
        job: {
          _id: item.job?._id || item.job,
          jobCode: item.job?.jobCode || null,
          title: item.job?.title || null,
          description:
            item.job?.completionSummary || item.job?.description || "Completed job",
          vehicleRegistration: item.job?.vehicle?.registration || null,
          completedAt: item.job?.completedAt || null,
        },
        invoice: invoice
          ? {
              _id: invoice._id,
              invoiceNo: invoice.invoiceNo,
              pdfUrl: invoice.pdfUrl || null,
            }
          : null,
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
    .populate("job", "jobCode title completedAt vehicle")
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

  return {
    period: {
      year,
      month: month + 1,
      label: start.toLocaleString("en-GB", { month: "long", year: "numeric" }),
      start,
      end,
    },
    currency: txs[0]?.currency || "GBP",
    totals,
    lineItems: txs.map((t) => ({
      _id: t._id,
      paidAt: t.paidAt,
      grossAmount: t.grossAmount,
      platformFee: t.platformFee,
      netAmount: t.netAmount,
      job: t.job
        ? {
            _id: t.job._id,
            jobCode: t.job.jobCode,
            title: t.job.title,
            completedAt: t.job.completedAt,
            vehicleRegistration: t.job.vehicle?.registration || null,
          }
        : null,
    })),
  };
};
