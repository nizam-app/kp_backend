import { Dispute } from "./dispute.model.js";
import { DisputeEvent } from "./disputeEvent.model.js";
import { DisputeTask } from "./disputeTask.model.js";
import { createNotification } from "../notification/notification.service.js";
import { notifyAdminsSafely } from "../notification/adminNotification.service.js";
import { ADMIN_NOTIFICATION_EVENTS } from "../notification/adminNotificationEvents.js";

const ACTIVE = [
  "OPEN",
  "TRIAGE",
  "AWAITING_CUSTOMER_EVIDENCE",
  "AWAITING_PROVIDER_EVIDENCE",
  "INVESTIGATING",
  "DECISION_PENDING",
  "APPEALED",
  "ESCALATED",
  "IN_REVIEW",
];

const createSystemEventOnce = async (dispute, type, correlationId, payload) => {
  const result = await DisputeEvent.updateOne(
    { dispute: dispute._id, correlationId },
    {
      $setOnInsert: {
        dispute: dispute._id,
        source: "SYSTEM",
        type,
        correlationId,
        toStatus: dispute.status,
        payload,
      },
    },
    { upsert: true }
  );
  return result.upsertedCount === 1;
};

const notifyUser = (user, dispute, title, body) =>
  user
    ? createNotification({
        user,
        type: "DISPUTE_UPDATED",
        eventKey: "DISPUTE_SLA",
        dedupeKey: `${dispute._id}:${title}`,
        title,
        body,
        data: {
          disputeId: dispute._id.toString(),
          caseNo: dispute.caseNo,
          screen: "DISPUTE_DETAIL",
        },
      })
    : null;

const processOverdueTasks = async (now) => {
  const tasks = await DisputeTask.find({ status: "OPEN", dueAt: { $lte: now } })
    .sort({ dueAt: 1 })
    .limit(200);
  let escalated = 0;
  for (const task of tasks) {
    const claimed = await DisputeTask.findOneAndUpdate(
      { _id: task._id, status: "OPEN" },
      { $set: { status: "OVERDUE", lastReminderAt: now }, $inc: { reminderCount: 1 } },
      { new: true }
    );
    if (!claimed) continue;
    const dispute = await Dispute.findById(task.dispute);
    if (!dispute) continue;
    const fresh = await createSystemEventOnce(
      dispute,
      "TASK_OVERDUE",
      `task-overdue:${task._id}`,
      { taskId: task._id, taskType: task.type, dueAt: task.dueAt }
    );
    if (!fresh) continue;
    if (task.owner) {
      await notifyUser(task.owner, dispute, `${dispute.caseNo} task overdue`, `${task.type} requires action.`);
    } else {
      await notifyAdminsSafely({
        eventKey: ADMIN_NOTIFICATION_EVENTS.DISPUTE_OPENED,
        dedupeKey: `dispute-task-overdue:${task._id}`,
        title: `${dispute.caseNo} missed an SLA`,
        body: `${task.type} was due ${task.dueAt.toISOString()}.`,
        data: { disputeId: dispute._id.toString(), screen: "ADMIN_DISPUTE" },
      });
    }
    escalated += 1;
  }
  return { checked: tasks.length, escalated };
};

const sendDeadlineReminders = async (now) => {
  const end = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const disputes = await Dispute.find({
    status: { $in: ACTIVE },
    $or: [
      { evidenceDueAt: { $gt: now, $lte: end } },
      { decisionDueAt: { $gt: now, $lte: end } },
      { stripeEvidenceDueAt: { $gt: now, $lte: end } },
    ],
  })
    .sort({ decisionDueAt: 1 })
    .limit(200);
  let sent = 0;
  const day = now.toISOString().slice(0, 10);
  for (const dispute of disputes) {
    const fresh = await createSystemEventOnce(
      dispute,
      "SLA_REMINDER_SENT",
      `sla-reminder:${dispute._id}:${day}`,
      {
        evidenceDueAt: dispute.evidenceDueAt,
        decisionDueAt: dispute.decisionDueAt,
        stripeEvidenceDueAt: dispute.stripeEvidenceDueAt,
      }
    );
    if (!fresh) continue;
    if (["CLAIMANT", "RESPONDENT"].includes(dispute.nextActionOwner)) {
      const owner =
        dispute.nextActionOwner === "CLAIMANT"
          ? dispute.claimant
          : dispute.respondent;
      await notifyUser(
        owner,
        dispute,
        `${dispute.caseNo} deadline approaching`,
        "Required case information is due within 24 hours."
      );
    } else {
      await notifyAdminsSafely({
        eventKey: ADMIN_NOTIFICATION_EVENTS.DISPUTE_OPENED,
        dedupeKey: `dispute-sla-reminder:${dispute._id}:${day}`,
        title: `${dispute.caseNo} deadline within 24 hours`,
        body: "Review the case and complete the next action.",
        data: { disputeId: dispute._id.toString(), screen: "ADMIN_DISPUTE" },
      });
    }
    sent += 1;
  }
  return { due: disputes.length, sent };
};

const escalateStaleCases = async (now) => {
  const staleBefore = new Date(now.getTime() - 72 * 60 * 60 * 1000);
  const disputes = await Dispute.find({
    status: { $in: ACTIVE.filter((status) => status !== "ESCALATED") },
    updatedAt: { $lte: staleBefore },
  })
    .sort({ updatedAt: 1 })
    .limit(100);
  let escalated = 0;
  for (const item of disputes) {
    const dispute = await Dispute.findOneAndUpdate(
      { _id: item._id, status: item.status, updatedAt: item.updatedAt },
      {
        $set: { status: "ESCALATED", nextActionOwner: "ADMIN" },
        $inc: { versionNumber: 1 },
      },
      { new: true }
    );
    if (!dispute) continue;
    await createSystemEventOnce(
      dispute,
      "CASE_AUTO_ESCALATED",
      `stale-escalation:${dispute._id}:${item.versionNumber}`,
      { previousStatus: item.status, staleSince: item.updatedAt }
    );
    escalated += 1;
  }
  return { checked: disputes.length, escalated };
};

export const runDisputeOperations = async ({ now = new Date() } = {}) => ({
  ranAt: now,
  overdueTasks: await processOverdueTasks(now),
  reminders: await sendDeadlineReminders(now),
  staleCases: await escalateStaleCases(now),
});
