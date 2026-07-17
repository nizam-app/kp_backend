import crypto from "crypto";
import AppError from "../../utils/AppError.js";
import { JOB_STATUS, ROLES, USER_STATUS } from "../../constants/domain.js";
import { User } from "../user/user.model.js";
import { Job } from "../job/job.model.js";
import { Quote } from "../quote/quote.model.js";
import { Invoice } from "../invoice/invoice.model.js";
import { Dispute } from "../dispute/dispute.model.js";
import { SupportTicket } from "../supportTicket/supportTicket.model.js";
import { ChatMessage } from "../chat/chat.model.js";
import { Review } from "../review/review.model.js";
import { Vehicle } from "../vehicle/vehicle.model.js";
import { Notification } from "../notification/notification.model.js";
import { DeviceToken } from "../notification/deviceToken.model.js";
import { PaymentMethod } from "../billing/paymentMethod.model.js";
import { writeAuditLog } from "../admin/admin.service.js";
import { DATA_RETENTION_POLICY } from "./gdpr.policy.js";

const ACTIVE_JOB_STATUSES = Object.values(JOB_STATUS).filter(
  (status) => ![JOB_STATUS.COMPLETED, JOB_STATUS.CANCELLED].includes(status)
);

const GDPR_ERASED_LABEL = "Erased user";

export const getDataRetentionPolicy = () => DATA_RETENTION_POLICY;

const maskToken = (token) =>
  typeof token === "string" && token.length > 8 ? `${token.slice(0, 8)}…` : "•••";

const sanitizePaymentMethod = (method) => ({
  _id: method._id,
  ownerType: method.ownerType,
  methodType: method.methodType,
  provider: method.provider,
  card: method.card
    ? { brand: method.card.brand, last4: method.card.last4 }
    : undefined,
  bank: method.bank
    ? {
        bankName: method.bank.bankName,
        accountMasked: method.bank.accountMasked,
        sortCodeMasked: method.bank.sortCodeMasked,
      }
    : undefined,
  isDefault: method.isDefault,
  isActive: method.isActive,
  createdAt: method.createdAt,
});

const findSubjectUser = async (userId) => {
  const user = await User.findById(userId);
  if (!user) throw new AppError("User not found", 404);
  return user;
};

export const exportUserGdprData = async (adminUser, userId) => {
  const user = await findSubjectUser(userId);
  const subjectFilter = { user: user._id };
  const partyFilter = {
    $or: [
      { fleet: user._id },
      { assignedMechanic: user._id },
      { assignedCompany: user._id },
    ],
  };

  const [
    jobs,
    quotes,
    invoices,
    disputes,
    supportTickets,
    chatMessages,
    reviews,
    vehicles,
    notifications,
    deviceTokens,
    paymentMethods,
  ] = await Promise.all([
    Job.find(partyFilter).sort({ createdAt: -1 }).lean(),
    Quote.find({
      $or: [
        { fleet: user._id },
        { mechanic: user._id },
        { company: user._id },
        { submittedBy: user._id },
      ],
    })
      .sort({ createdAt: -1 })
      .lean(),
    Invoice.find({ $or: [{ fleet: user._id }, { mechanic: user._id }] })
      .sort({ createdAt: -1 })
      .lean(),
    Dispute.find({ $or: [{ company: user._id }, { mechanic: user._id }] })
      .sort({ createdAt: -1 })
      .lean(),
    SupportTicket.find(subjectFilter).sort({ createdAt: -1 }).lean(),
    ChatMessage.find({ sender: user._id }).sort({ createdAt: -1 }).lean(),
    Review.find({ $or: [{ fleet: user._id }, { mechanic: user._id }] })
      .sort({ createdAt: -1 })
      .lean(),
    Vehicle.find({ fleet: user._id }).sort({ createdAt: -1 }).lean(),
    Notification.find(subjectFilter).sort({ createdAt: -1 }).lean(),
    DeviceToken.find(subjectFilter).lean(),
    PaymentMethod.find(subjectFilter).lean(),
  ]);

  const report = {
    format: "kp-gdpr-export/1",
    generatedAt: new Date().toISOString(),
    generatedBy: adminUser?.email || "admin",
    subject: {
      _id: user._id,
      email: user.email,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
    },
    counts: {
      jobs: jobs.length,
      quotes: quotes.length,
      invoices: invoices.length,
      disputes: disputes.length,
      supportTickets: supportTickets.length,
      chatMessages: chatMessages.length,
      reviews: reviews.length,
      vehicles: vehicles.length,
      notifications: notifications.length,
      deviceTokens: deviceTokens.length,
      paymentMethods: paymentMethods.length,
    },
    data: {
      account: user.toJSON(),
      jobs,
      quotes,
      invoices,
      disputes,
      supportTickets,
      chatMessages,
      reviews,
      vehicles,
      notifications,
      deviceTokens: deviceTokens.map((token) => ({
        _id: token._id,
        platform: token.platform,
        token: maskToken(token.token),
        isActive: token.isActive,
        createdAt: token.createdAt,
      })),
      paymentMethods: paymentMethods.map(sanitizePaymentMethod),
    },
  };

  await writeAuditLog(
    adminUser,
    `Exported GDPR data report for ${user.email}`,
    `User ${user._id}`,
    "Compliance"
  );

  return report;
};

export const eraseUserGdprData = async (adminUser, userId, payload = {}) => {
  const user = await findSubjectUser(userId);

  if (user.role === ROLES.ADMIN) {
    throw new AppError("Admin accounts cannot be erased with GDPR tooling", 400);
  }

  const confirmEmail = `${payload.confirmEmail || ""}`.trim().toLowerCase();
  if (!confirmEmail || confirmEmail !== user.email) {
    throw new AppError(
      "Type the user's email exactly to confirm irreversible erasure",
      400
    );
  }

  const activeJobs = await Job.countDocuments({
    $or: [
      { fleet: user._id },
      { assignedMechanic: user._id },
      { assignedCompany: user._id },
    ],
    status: { $in: ACTIVE_JOB_STATUSES },
  });
  if (activeJobs > 0) {
    throw new AppError(
      `User has ${activeJobs} active job(s). Complete or cancel them before erasure.`,
      409
    );
  }

  if ([ROLES.FLEET, ROLES.COMPANY].includes(user.role)) {
    const activeMembers = await User.countDocuments({
      "companyMembership.company": user._id,
      "companyMembership.status": { $in: ["ACTIVE", "PENDING"] },
    });
    if (activeMembers > 0) {
      throw new AppError(
        `Account still has ${activeMembers} active team member(s). Remove them before erasure.`,
        409
      );
    }
  }

  const originalEmail = user.email;

  const [
    notificationsResult,
    deviceTokensResult,
    paymentMethodsResult,
    chatResult,
    reviewsAsFleetResult,
    reviewsAsMechanicResult,
    vehiclesResult,
  ] = await Promise.all([
    Notification.deleteMany({ user: user._id }),
    DeviceToken.deleteMany({ user: user._id }),
    PaymentMethod.updateMany(
      { user: user._id },
      { $set: { isActive: false, isDefault: false, billingAddress: "" } }
    ),
    ChatMessage.updateMany(
      { sender: user._id },
      { $set: { text: "[Removed under GDPR erasure]", attachments: [] } }
    ),
    Review.updateMany(
      { fleet: user._id },
      { $set: { customerName: GDPR_ERASED_LABEL, companyName: "", comment: "" } }
    ),
    Review.updateMany(
      { mechanic: user._id },
      { $set: { mechanicName: GDPR_ERASED_LABEL } }
    ),
    Vehicle.deleteMany({ fleet: user._id }),
  ]);

  // Anonymize the account itself; retained so historical jobs/invoices keep a valid reference.
  user.email = `erased-${user._id}@gdpr-erased.invalid`;
  user.password = crypto.randomBytes(32).toString("hex");
  user.status = USER_STATUS.BLOCKED;
  user.set("adminProfile", undefined);
  user.set("fleetProfile", undefined);
  user.set("companyProfile", undefined);
  user.set("mechanicProfile", undefined);
  user.set("companyMembership", undefined);
  user.set("refreshTokenHash", undefined);
  await user.save();

  const [retainedJobs, retainedInvoices, retainedDisputes, retainedTickets] =
    await Promise.all([
      Job.countDocuments({
        $or: [
          { fleet: user._id },
          { assignedMechanic: user._id },
          { assignedCompany: user._id },
        ],
      }),
      Invoice.countDocuments({
        $or: [{ fleet: user._id }, { mechanic: user._id }],
      }),
      Dispute.countDocuments({
        $or: [{ company: user._id }, { mechanic: user._id }],
      }),
      SupportTicket.countDocuments({ user: user._id }),
    ]);

  await writeAuditLog(
    adminUser,
    `GDPR erasure executed for ${originalEmail}`,
    `User ${user._id}`,
    "Compliance"
  );

  return {
    user: {
      _id: user._id,
      originalEmail,
      anonymizedEmail: user.email,
      status: user.status,
    },
    erased: {
      notificationsDeleted: notificationsResult.deletedCount || 0,
      deviceTokensDeleted: deviceTokensResult.deletedCount || 0,
      paymentMethodsDeactivated: paymentMethodsResult.modifiedCount || 0,
      chatMessagesRedacted: chatResult.modifiedCount || 0,
      reviewsRedacted:
        (reviewsAsFleetResult.modifiedCount || 0) +
        (reviewsAsMechanicResult.modifiedCount || 0),
      vehiclesDeleted: vehiclesResult.deletedCount || 0,
      profileAnonymized: true,
    },
    retained: {
      jobs: retainedJobs,
      invoices: retainedInvoices,
      disputes: retainedDisputes,
      supportTickets: retainedTickets,
      note: "Financial and service records are retained under the data retention policy; they now reference the anonymized account.",
    },
  };
};
