const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const CATEGORY_RULES = [
  [/^\/service-requests/, "Service Management"],
  [/^\/users/, "User Management"],
  [/^\/fleet/, "Fleet Management"],
  [/^\/financial/, "Financial"],
  [/^\/settings/, "Settings"],
  [/^\/support/, "Support"],
  [/^\/disputes/, "Disputes"],
  [/^\/notifications/, "Notifications"],
  [/^\/service-catalog/, "Service Catalog"],
  [/^\/job-categories/, "Job Categories"],
  [/^\/promotions/, "Promotions"],
  [/^\/reviews/, "Reviews"],
  [/^\/mechanics/, "Mechanic Verification"],
];

const firstUsefulValue = (source = {}, keys = []) => {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && `${value}`.trim()) {
      return `${value}`.trim();
    }
  }
  return null;
};

export const deriveAdminAuditDescriptor = ({
  method,
  routePath,
  params = {},
  body = {},
} = {}) => {
  const normalizedMethod = `${method || ""}`.trim().toUpperCase();
  if (!MUTATING_METHODS.has(normalizedMethod)) return null;

  const normalizedPath = `${routePath || "/"}`.trim() || "/";
  const category =
    CATEGORY_RULES.find(([pattern]) => pattern.test(normalizedPath))?.[1] ||
    "Admin";
  const paramTarget = firstUsefulValue(params, [
    "jobId",
    "userId",
    "fleetId",
    "vehicleId",
    "ticketId",
    "disputeId",
    "notificationId",
    "serviceId",
    "categoryId",
    "promotionId",
    "reviewId",
  ]);
  const bodyTarget = firstUsefulValue(body, [
    "email",
    "title",
    "name",
    "code",
    "status",
    "invoiceNo",
  ]);

  return {
    action: `${normalizedMethod} ${normalizedPath}`,
    target: paramTarget || bodyTarget || category,
    category,
  };
};
