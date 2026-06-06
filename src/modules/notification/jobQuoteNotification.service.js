import { JOB_STATUS } from "../../constants/domain.js";
import { createNotification } from "./notification.service.js";

const toId = (value) => {
  if (!value) return null;
  if (typeof value === "object" && value._id) return `${value._id}`;
  return `${value}`;
};

const uniqueUserIds = (ids) =>
  [...new Set(ids.map((id) => toId(id)).filter(Boolean))];

const moneyLabel = (amount, currency = "GBP") => {
  const sym = `${currency}`.toUpperCase() === "ZAR" ? "R" : "£";
  return `${sym}${Number(amount || 0).toFixed(2)}`;
};

const jobData = (job, extra = {}) => ({
  jobId: toId(job._id || job),
  jobCode: job.jobCode || null,
  jobStatus: job.status || null,
  screen: "JOB_DETAIL",
  ...extra,
});

const quoteData = (job, quote, extra = {}) => ({
  ...jobData(job, extra),
  quoteId: toId(quote._id || quote),
  quoteAmount: quote.amount != null ? Number(quote.amount) : null,
  quoteStatus: quote.status || null,
  screen: "JOB_QUOTES",
});

const notifyUsers = async (userIds, payload) => {
  const targets = uniqueUserIds(userIds);
  if (!targets.length) return;
  await Promise.all(
    targets.map((userId) =>
      createNotification({ user: userId, ...payload }).catch((err) => {
        console.error("[notify] createNotification failed:", err?.message || err);
      })
    )
  );
};

const fleetAndCompanyRecipients = (job) =>
  uniqueUserIds([job.fleet, job.assignedCompany]);

/** New quote submitted on fleet job. */
export const notifyQuoteSubmitted = async (job, quote, submitter) => {
  const name =
    submitter?.mechanicProfile?.displayName ||
    submitter?.companyProfile?.companyName ||
    "A provider";
  await notifyUsers([job.fleet], {
    type: "QUOTE_RECEIVED",
    title: `New quote for ${job.jobCode}`,
    body: `${name} quoted ${moneyLabel(quote.amount, job.currency)}.`,
    data: quoteData(job, quote, { screen: "JOB_QUOTES" }),
  });
};

/** Fleet accepted a quote — notify winning mechanic/company. */
export const notifyQuoteAccepted = async (job, quote) => {
  const recipients = uniqueUserIds([
    quote.mechanic,
    quote.company,
    quote.submittedBy,
  ]);
  await notifyUsers(recipients, {
    type: "QUOTE_ACCEPTED",
    title: `Quote accepted for ${job.jobCode}`,
    body: `Your ${moneyLabel(quote.amount, job.currency)} quote was accepted. Job is assigned.`,
    data: quoteData(job, quote, { screen: "JOB_DETAIL", jobStatus: JOB_STATUS.ASSIGNED }),
  });
};

/** Fleet declined a quote. */
export const notifyQuoteDeclined = async (job, quote) => {
  await notifyUsers([quote.mechanic, quote.submittedBy], {
    type: "QUOTE_DECLINED",
    title: `Quote declined for ${job.jobCode}`,
    body: "The fleet operator declined your quote.",
    data: quoteData(job, quote),
  });
};

/** Mechanic/company amended a waiting quote. */
export const notifyQuoteAmended = async (job, quote) => {
  await notifyUsers([job.fleet], {
    type: "QUOTE_UPDATED",
    title: `Quote updated for ${job.jobCode}`,
    body: `New amount: ${moneyLabel(quote.amount, job.currency)}.`,
    data: quoteData(job, quote, { screen: "JOB_QUOTES" }),
  });
};

/** Mechanic/company withdrew a quote. */
export const notifyQuoteWithdrawn = async (job, quote) => {
  await notifyUsers([job.fleet], {
    type: "QUOTE_WITHDRAWN",
    title: `Quote withdrawn for ${job.jobCode}`,
    body: "A provider withdrew their quote.",
    data: quoteData(job, quote, { screen: "JOB_QUOTES" }),
  });
};

/** Other waiting quotes auto-declined when fleet accepts one. */
export const notifyQuotesNotSelected = async (job, declinedQuotes = []) => {
  await Promise.all(
    declinedQuotes.map((quote) =>
      notifyUsers([quote.mechanic, quote.submittedBy], {
        type: "QUOTE_NOT_SELECTED",
        title: `Quote not selected for ${job.jobCode}`,
        body: "Another quote was accepted for this job.",
        data: quoteData(job, quote),
      })
    )
  );
};

/** Company assigned (or reassigned) a mechanic employee. */
export const notifyMechanicAssigned = async (job, mechanicId, { reassigned = false } = {}) => {
  await notifyUsers([mechanicId], {
    type: reassigned ? "JOB_MECHANIC_REASSIGNED" : "JOB_ASSIGNED",
    title: reassigned ? `Job reassigned: ${job.jobCode}` : `New job assigned: ${job.jobCode}`,
    body: reassigned
      ? "You have been reassigned to this company job."
      : "A company dispatcher assigned you to a job.",
    data: jobData(job, { screen: "JOB_DETAIL" }),
  });
};

const STATUS_NOTIFY = {
  [JOB_STATUS.EN_ROUTE]: {
    type: "JOB_STATUS_EN_ROUTE",
    title: (code) => `Mechanic en route — ${code}`,
    body: "Your assigned mechanic is on the way.",
  },
  [JOB_STATUS.ON_SITE]: {
    type: "JOB_STATUS_ON_SITE",
    title: (code) => `Mechanic arrived — ${code}`,
    body: "The mechanic has arrived on site.",
  },
  [JOB_STATUS.IN_PROGRESS]: {
    type: "JOB_STATUS_IN_PROGRESS",
    title: (code) => `Work started — ${code}`,
    body: "Repair work is now in progress.",
  },
  [JOB_STATUS.AWAITING_APPROVAL]: {
    type: "JOB_AWAITING_APPROVAL",
    title: (code) => `Approval needed — ${code}`,
    body: "Mechanic submitted completion. Review and approve to pay.",
  },
};

/** Mechanic progress updates → notify fleet (+ company if on job). */
export const notifyJobStatusChanged = async (job, toStatus) => {
  const cfg = STATUS_NOTIFY[toStatus];
  if (!cfg) return;

  await notifyUsers(fleetAndCompanyRecipients(job), {
    type: cfg.type,
    title: cfg.title(job.jobCode),
    body: cfg.body,
    data: jobData(job, { jobStatus: toStatus }),
  });
};

/** Fleet cancelled job. */
export const notifyJobCancelled = async (job, reason) => {
  const body = reason
    ? `Job cancelled: ${`${reason}`.slice(0, 120)}`
    : "This job was cancelled by the fleet operator.";

  await notifyUsers(
    uniqueUserIds([job.assignedMechanic, job.assignedCompany]),
    {
      type: "JOB_CANCELLED",
      title: `Job cancelled — ${job.jobCode}`,
      body,
      data: jobData(job, { jobStatus: JOB_STATUS.CANCELLED, reason: reason || null }),
    }
  );
};

/** Job approved & completed — notify mechanic (payout recorded). */
export const notifyJobCompleted = async (job, { approvedByCompany = false } = {}) => {
  if (!job.assignedMechanic) return;

  await notifyUsers([job.assignedMechanic], {
    type: "JOB_COMPLETED",
    title: `Job completed — ${job.jobCode}`,
    body: approvedByCompany
      ? "Company approved completion. Payment has been recorded."
      : "Fleet approved completion. Payment has been recorded.",
    data: jobData(job, {
      jobStatus: JOB_STATUS.COMPLETED,
      approvedByCompany: approvedByCompany ? "true" : "false",
    }),
  });
};
