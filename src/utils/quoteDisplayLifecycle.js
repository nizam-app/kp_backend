import { JOB_STATUS, QUOTE_STATUS } from "../constants/domain.js";

/** Job statuses where an accepted quote still has an actionable active job. */
export const ACTIVE_JOB_STATUSES_FOR_QUOTE = new Set([
  JOB_STATUS.ASSIGNED,
  JOB_STATUS.EN_ROUTE,
  JOB_STATUS.ON_SITE,
  JOB_STATUS.IN_PROGRESS,
]);

const IN_PROGRESS_JOB_STATUSES = new Set([
  JOB_STATUS.EN_ROUTE,
  JOB_STATUS.ON_SITE,
  JOB_STATUS.IN_PROGRESS,
]);

export const quoteDisplayStatusUi = (status) => {
  const map = {
    WAITING: { label: "Waiting", tone: "amber" },
    ACCEPTED: { label: "Accepted", tone: "green" },
    IN_PROGRESS: { label: "In progress", tone: "blue" },
    AWAITING_APPROVAL: { label: "Awaiting approval", tone: "amber" },
    COMPLETED: { label: "Completed", tone: "green" },
    CANCELLED: { label: "Cancelled", tone: "neutral" },
    DECLINED: { label: "Declined", tone: "red" },
    EXPIRED: { label: "Expired", tone: "neutral" },
    WITHDRAWN: { label: "Withdrawn", tone: "neutral" },
  };
  return map[status] || { label: status, tone: "neutral" };
};

export const quoteSummaryLineForDisplay = (displayStatus) => {
  switch (displayStatus) {
    case "COMPLETED":
      return "Job completed — payment released";
    case "CANCELLED":
      return "Job was cancelled";
    case "AWAITING_APPROVAL":
      return "Work done — waiting for fleet approval";
    case "IN_PROGRESS":
      return "Job in progress — open tracker";
    case QUOTE_STATUS.ACCEPTED:
      return "Accepted! Tap to view active job";
    case QUOTE_STATUS.WAITING:
      return "Waiting for fleet response";
    case QUOTE_STATUS.EXPIRED:
      return "Quote expired";
    case QUOTE_STATUS.WITHDRAWN:
      return "Quote withdrawn";
    case QUOTE_STATUS.DECLINED:
      return "Quote declined";
    default:
      return null;
  }
};

/**
 * Quote.status stays ACCEPTED after win; UI must reflect linked job outcome
 * (Completed / In progress / Cancelled) so mechanic matches fleet timeline.
 *
 * @param {{ status?: string, job?: { status?: string } | null }} quote
 */
export const resolveQuoteDisplayLifecycle = (quote) => {
  const quoteStatus = `${quote?.status || ""}`.toUpperCase();
  const jobStatus = `${quote?.job?.status || ""}`.toUpperCase();

  if (quoteStatus !== QUOTE_STATUS.ACCEPTED) {
    return {
      displayStatus: quoteStatus || QUOTE_STATUS.WAITING,
      canOpenActiveJob: false,
    };
  }

  if (jobStatus === JOB_STATUS.COMPLETED) {
    return { displayStatus: "COMPLETED", canOpenActiveJob: false };
  }
  if (jobStatus === JOB_STATUS.CANCELLED) {
    return { displayStatus: "CANCELLED", canOpenActiveJob: false };
  }
  if (jobStatus === JOB_STATUS.AWAITING_APPROVAL) {
    return { displayStatus: "AWAITING_APPROVAL", canOpenActiveJob: true };
  }
  if (IN_PROGRESS_JOB_STATUSES.has(jobStatus)) {
    return { displayStatus: "IN_PROGRESS", canOpenActiveJob: true };
  }
  if (ACTIVE_JOB_STATUSES_FOR_QUOTE.has(jobStatus) || !jobStatus) {
    return { displayStatus: QUOTE_STATUS.ACCEPTED, canOpenActiveJob: true };
  }

  return { displayStatus: QUOTE_STATUS.ACCEPTED, canOpenActiveJob: false };
};
