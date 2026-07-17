import { ROLES } from "../../constants/domain.js";
import { Job } from "../job/job.model.js";
import { Dispute } from "../dispute/dispute.model.js";
import { Invoice } from "../invoice/invoice.model.js";
import { User } from "../user/user.model.js";
import { dispatchAdminNotificationEvent } from "./adminNotification.service.js";
import { ADMIN_NOTIFICATION_EVENTS } from "./adminNotificationEvents.js";

export const buildWeeklyAdminDigest = async ({ now = new Date() } = {}) => {
  const periodEnd = new Date(now);
  const periodStart = new Date(periodEnd.getTime() - 7 * 24 * 60 * 60 * 1000);
  const [jobsPosted, disputesOpened, failedPayments, mechanicsRegistered, paidAgg] =
    await Promise.all([
      Job.countDocuments({ createdAt: { $gte: periodStart, $lt: periodEnd } }),
      Dispute.countDocuments({ createdAt: { $gte: periodStart, $lt: periodEnd } }),
      Invoice.countDocuments({
        status: "FAILED",
        updatedAt: { $gte: periodStart, $lt: periodEnd },
      }),
      User.countDocuments({
        role: ROLES.MECHANIC,
        createdAt: { $gte: periodStart, $lt: periodEnd },
      }),
      Invoice.aggregate([
        {
          $match: {
            status: "PAID",
            paidAt: { $gte: periodStart, $lt: periodEnd },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: "$totalAmount" },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

  return {
    periodStart,
    periodEnd,
    jobsPosted,
    disputesOpened,
    failedPayments,
    mechanicsRegistered,
    paidInvoices: paidAgg[0]?.count || 0,
    paidVolume: Math.round((paidAgg[0]?.total || 0) * 100) / 100,
  };
};

export const sendWeeklyAdminDigest = async ({ now = new Date() } = {}) => {
  const digest = await buildWeeklyAdminDigest({ now });
  const body = [
    `${digest.jobsPosted} jobs posted`,
    `${digest.disputesOpened} disputes opened`,
    `${digest.failedPayments} failed payments`,
    `${digest.mechanicsRegistered} mechanic registrations`,
    `${digest.paidInvoices} paid invoices (£${digest.paidVolume.toFixed(2)})`,
  ].join(" · ");

  return dispatchAdminNotificationEvent({
    eventKey: ADMIN_NOTIFICATION_EVENTS.WEEKLY_DIGEST,
    dedupeKey: `weekly-digest:${digest.periodStart.toISOString().slice(0, 10)}`,
    title: "TruckFix weekly performance digest",
    body,
    emailSubject: "Your TruckFix admin weekly digest",
    data: {
      ...digest,
      periodStart: digest.periodStart.toISOString(),
      periodEnd: digest.periodEnd.toISOString(),
      screen: "ADMIN_REPORTS",
    },
  });
};
