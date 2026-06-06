/**
 * Maps persisted notification type + data to a Flutter-friendly navigation target.
 * Also flattened into FCM `data` (screen, jobId, messageId, …) for tap handlers.
 */
export const buildNotificationNavigation = (type, data = {}) => {
  const d = data && typeof data === "object" ? data : {};

  switch (type) {
    case "CHAT_MESSAGE": {
      const jobId = d.jobId != null ? `${d.jobId}` : "";
      if (!jobId) return null;
      return {
        screen: "JOB_CHAT",
        params: {
          jobId,
          ...(d.jobCode ? { jobCode: `${d.jobCode}` } : {}),
          ...(d.messageId ? { messageId: `${d.messageId}` } : {}),
        },
      };
    }
    case "SUPPORT_TICKET_CREATED":
    case "SUPPORT_TICKET_UPDATED": {
      const ticketId = d.ticketId != null ? `${d.ticketId}` : "";
      if (!ticketId) return null;
      return {
        screen: "SUPPORT_TICKET",
        params: { ticketId },
      };
    }
    case "REVIEW_CREATED":
    case "JOB_ASSIGNED":
    case "JOB_MECHANIC_REASSIGNED":
    case "JOB_STATUS_EN_ROUTE":
    case "JOB_STATUS_ON_SITE":
    case "JOB_STATUS_IN_PROGRESS":
    case "JOB_AWAITING_APPROVAL":
    case "JOB_COMPLETED":
    case "JOB_CANCELLED":
    case "QUOTE_ACCEPTED": {
      const jobId = d.jobId != null ? `${d.jobId}` : "";
      if (!jobId) return null;
      return {
        screen: "JOB_DETAIL",
        params: {
          jobId,
          ...(d.jobCode ? { jobCode: `${d.jobCode}` } : {}),
          ...(d.jobStatus ? { jobStatus: `${d.jobStatus}` } : {}),
          ...(d.reviewId ? { reviewId: `${d.reviewId}` } : {}),
        },
      };
    }
    case "QUOTE_RECEIVED":
    case "QUOTE_DECLINED":
    case "QUOTE_UPDATED":
    case "QUOTE_WITHDRAWN":
    case "QUOTE_NOT_SELECTED": {
      const jobId = d.jobId != null ? `${d.jobId}` : "";
      if (!jobId) return null;
      return {
        screen: "JOB_QUOTES",
        params: {
          jobId,
          ...(d.jobCode ? { jobCode: `${d.jobCode}` } : {}),
          ...(d.quoteId ? { quoteId: `${d.quoteId}` } : {}),
        },
      };
    }
    default:
      return null;
  }
};

/** Flat keys for FCM data payloads (all string values). */
export const flattenNavigationForPush = (navigation) => {
  if (!navigation?.screen) return {};
  return {
    screen: navigation.screen,
    ...(navigation.params || {}),
  };
};
