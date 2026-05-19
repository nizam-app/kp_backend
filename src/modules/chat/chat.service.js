import AppError from "../../utils/AppError.js";
import { ChatMessage } from "./chat.model.js";
import { Job } from "../job/job.model.js";
import { JobEvent } from "../jobEvent/jobEvent.model.js";
import { ROLES } from "../../constants/domain.js";
import { createNotification } from "../notification/notification.service.js";
import { uploadChatAttachmentBuffer } from "../media/media.service.js";
import { emitChatMessage, emitChatMessagesRead } from "../../realtime/socket.js";

const parsePage = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
};

const parseLimit = (value, fallback = 30, max = 100) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
};

const toId = (value) => (value?._id || value)?.toString?.() || null;

const uniqueIds = (values = []) => [...new Set(values.map(toId).filter(Boolean))];

const SENDER_POPULATE_FIELDS =
  "email role fleetProfile mechanicProfile companyProfile companyMembership.displayName companyMembership.company";


const senderProfilePhotoUrl = (user) =>
  user?.mechanicProfile?.profilePhotoUrl ||
  user?.companyProfile?.profilePhotoUrl ||
  user?.fleetProfile?.profilePhotoUrl ||
  null;

const participantLabel = (user) => {
  if (!user) return null;
  if (user.role === ROLES.FLEET) {
    return user.fleetProfile?.companyName || user.fleetProfile?.contactName || user.email;
  }
  if (user.role === ROLES.MECHANIC) {
    return (
      user.mechanicProfile?.displayName ||
      user.mechanicProfile?.businessName ||
      user.email
    );
  }
  if (user.role === ROLES.COMPANY) {
    return (
      user.companyProfile?.companyName ||
      user.companyProfile?.contactName ||
      user.email
    );
  }
  if (user.role === ROLES.MECHANIC_EMPLOYEE) {
    return (
      user.mechanicProfile?.displayName ||
      user.companyMembership?.displayName ||
      user.email
    );
  }
  return user.email || null;
};

const serializeMessage = (message, userId) => ({
  _id: message._id,
  jobId: toId(message.job),
  sender: message.sender
    ? {
        _id: toId(message.sender),
        role: message.sender.role || null,
        label: participantLabel(message.sender),
        profilePhotoUrl: senderProfilePhotoUrl(message.sender),
      }
    : null,
  text: message.text ?? "",
  attachments: message.attachments || [],
  createdAt: message.createdAt,
  updatedAt: message.updatedAt,
  isOwn: toId(message.sender) === userId,
  isRead: Array.isArray(message.readBy)
    ? message.readBy.some((item) => toId(item.user) === userId)
    : false,
});

const ensureChatAccess = async (jobId, user) => {
  const job = await Job.findById(jobId)
    .populate("fleet", "email role fleetProfile")
    .populate("assignedCompany", "email role companyProfile")
    .populate(
      "assignedMechanic",
      "email role mechanicProfile companyMembership.displayName companyMembership.company"
    );

  if (!job) throw new AppError("Job not found", 404);
  if (user.role === ROLES.ADMIN) return job;

  const userId = toId(user._id);
  const fleetId = toId(job.fleet);
  const mechanicId = toId(job.assignedMechanic);
  const companyId = toId(job.assignedCompany);
  const employeeCompanyId = toId(user.companyMembership?.company);

  if (user.role === ROLES.FLEET && fleetId === userId) return job;
  if (user.role === ROLES.MECHANIC && mechanicId === userId) return job;
  if (user.role === ROLES.COMPANY && companyId === userId) return job;
  if (user.role === ROLES.MECHANIC_EMPLOYEE && mechanicId === userId) return job;
  if (user.role === ROLES.MECHANIC_EMPLOYEE && employeeCompanyId && companyId === employeeCompanyId) {
    return job;
  }

  throw new AppError("Forbidden", 403);
};

const buildCounterparty = (job, user) => {
  if (user.role === ROLES.FLEET) {
    if (job.assignedMechanic) {
      return {
        _id: toId(job.assignedMechanic),
        role: job.assignedMechanic.role,
        label: participantLabel(job.assignedMechanic),
        profilePhotoUrl: senderProfilePhotoUrl(job.assignedMechanic),
      };
    }

    return job.assignedCompany
      ? {
          _id: toId(job.assignedCompany),
          role: job.assignedCompany.role,
          label: participantLabel(job.assignedCompany),
          profilePhotoUrl: senderProfilePhotoUrl(job.assignedCompany),
        }
      : null;
  }

  return job.fleet
    ? {
        _id: toId(job.fleet),
        role: job.fleet.role,
        label: participantLabel(job.fleet),
        profilePhotoUrl: senderProfilePhotoUrl(job.fleet),
      }
    : null;
};

const buildJobThreadRow = (job, user, threadMessages, userIdStr) => {
  const lastMessage = threadMessages[0] || null;
  const unreadCount = threadMessages.filter((message) => {
    const senderId = toId(message.sender);
    const isRead = (message.readBy || []).some((item) => toId(item.user) === userIdStr);
    return senderId !== userIdStr && !isRead;
  }).length;

  const counterparty = buildCounterparty(job, user);

  return {
    threadType: "JOB",
    conversationId: toId(job._id),
    title: counterparty?.label || "Chat",
    subtitle: [job.jobCode, job.title].filter(Boolean).join(" · ") || null,
    job: {
      _id: job._id,
      jobCode: job.jobCode,
      title: job.title,
      status: job.status,
      vehicle: job.vehicle || null,
      location: job.location || null,
    },
    counterparty,
    unreadCount,
    lastMessage: lastMessage ? serializeMessage(lastMessage, userIdStr) : null,
    updatedAt: lastMessage?.createdAt || job.updatedAt || job.createdAt,
  };
};

export const listChatThreads = async (user, query = {}) => {
  const page = parsePage(query.page);
  const limit = parseLimit(query.limit, 20, 50);
  const skip = (page - 1) * limit;

  const jobFilter = {};
  if (user.role === ROLES.FLEET) jobFilter.fleet = user._id;
  if (user.role === ROLES.MECHANIC) jobFilter.assignedMechanic = user._id;
  if (user.role === ROLES.COMPANY) jobFilter.assignedCompany = user._id;
  if (user.role === ROLES.MECHANIC_EMPLOYEE) {
    jobFilter.$or = [
      { assignedMechanic: user._id },
      { assignedCompany: user.companyMembership?.company },
    ].filter((item) => Object.values(item)[0]);
  }

  const jobs = await Job.find(jobFilter)
    .sort({ updatedAt: -1, createdAt: -1 })
    .populate("fleet", "email role fleetProfile")
    .populate("assignedCompany", "email role companyProfile")
    .populate(
      "assignedMechanic",
      "email role mechanicProfile companyMembership.displayName companyMembership.company"
    )
    .lean();

  const jobIds = jobs.map((job) => job._id);
  const messages = jobIds.length
    ? await ChatMessage.find({ job: { $in: jobIds } })
        .sort({ createdAt: -1 })
        .populate("sender", SENDER_POPULATE_FIELDS)
        .lean()
    : [];

  const userIdStr = toId(user._id);

  const jobThreads = jobs
    .map((job) => {
      const threadMessages = messages.filter((message) => toId(message.job) === toId(job._id));
      return buildJobThreadRow(job, user, threadMessages, userIdStr);
    })
    .filter((thread) => thread.threadType === "JOB" && thread.counterparty);

  jobThreads.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  const paged = jobThreads.slice(skip, skip + limit);

  const unreadThreads = jobThreads.filter((item) => item.unreadCount > 0).length;

  return {
    items: paged,
    meta: {
      page,
      limit,
      total: jobThreads.length,
      totalPages: Math.ceil(jobThreads.length / limit) || 1,
      unreadThreads,
    },
  };
};

export const listJobMessages = async (jobId, user, query = {}) => {
  const job = await ensureChatAccess(jobId, user);
  const limit = parseLimit(query.limit, 50, 200);
  const beforeRaw = query.before ?? query.beforeMessageId;

  const filter = { job: job._id };
  if (beforeRaw) {
    const ref = await ChatMessage.findOne({ _id: beforeRaw, job: job._id }).select("createdAt").lean();
    if (!ref) throw new AppError("Invalid before message cursor", 400);
    filter.createdAt = { $lt: ref.createdAt };
  }

  const take = limit + 1;
  let rows = await ChatMessage.find(filter)
    .sort({ createdAt: -1 })
    .limit(take)
    .populate("sender", SENDER_POPULATE_FIELDS)
    .lean();

  const hasOlder = rows.length > limit;
  if (hasOlder) rows = rows.slice(0, limit);
  rows.reverse();

  const items = rows.map((message) => serializeMessage(message, toId(user._id)));
  const oldestId = rows.length ? toId(rows[0]._id) : null;
  const newestId = rows.length ? toId(rows[rows.length - 1]._id) : null;

  return {
    job: {
      _id: job._id,
      jobCode: job.jobCode,
      title: job.title,
      status: job.status,
      location: job.location || null,
    },
    counterparty: buildCounterparty(job, user),
    items,
    meta: {
      limit,
      hasOlder,
      /** False on the latest page; true when `before` was used (newer messages exist below). */
      hasNewer: Boolean(beforeRaw),
      /** Pass as `before` to load the next older page. */
      nextBefore: hasOlder ? oldestId : null,
      oldestMessageId: oldestId,
      newestMessageId: newestId,
    },
  };
};

export const sendJobMessage = async (jobId, user, payload = {}) => {
  const job = await ensureChatAccess(jobId, user);
  const text = `${payload.text ?? ""}`.trim();
  const attachments = Array.isArray(payload.attachments)
    ? [...new Set(payload.attachments.map((u) => `${u || ""}`.trim()).filter(Boolean))]
    : [];

  if (!text && !attachments.length) {
    throw new AppError("text or at least one attachment URL is required", 400);
  }

  const recipients =
    user.role === ROLES.FLEET
      ? uniqueIds([job.assignedMechanic, job.assignedCompany])
      : user.role === ROLES.ADMIN
        ? uniqueIds([job.fleet, job.assignedMechanic, job.assignedCompany])
        : uniqueIds([job.fleet]);
  if (!recipients.length) {
    throw new AppError("No chat recipient is available for this job", 400);
  }

  const message = await ChatMessage.create({
    job: job._id,
    sender: user._id,
    text,
    attachments,
    readBy: [{ user: user._id, readAt: new Date() }],
  });

  const notificationBody = (() => {
    if (text) return text.length > 120 ? `${text.slice(0, 117)}...` : text;
    if (attachments.length) return "Image";
    return "New message";
  })();

  await Promise.all(
    recipients.map((recipient) =>
      createNotification({
        user: recipient,
        type: "CHAT_MESSAGE",
        title: `New job message for ${job.jobCode}`,
        body: notificationBody,
        data: {
          jobId: toId(job._id),
          jobCode: job.jobCode,
          senderId: toId(user._id),
          messageId: toId(message._id),
          screen: "JOB_CHAT",
        },
      })
    )
  );

  await JobEvent.create({
    job: job._id,
    actor: user._id,
    type: "CHAT_MESSAGE_SENT",
    note: text || (attachments.length ? "(attachment)" : ""),
    payload: {
      textLength: text.length,
      attachmentCount: attachments.length,
    },
  });

  const populated = await ChatMessage.findById(message._id).populate("sender", SENDER_POPULATE_FIELDS);

  const serialized = serializeMessage(populated, toId(user._id));
  const participants = uniqueIds([job.fleet, job.assignedMechanic, job.assignedCompany]);
  emitChatMessage({
    jobId: toId(job._id),
    message: serialized,
    participants,
  });

  return serialized;
};

export const markJobMessagesRead = async (jobId, user) => {
  const job = await ensureChatAccess(jobId, user);
  const userId = toId(user._id);

  const unreadMessages = await ChatMessage.find({
    job: job._id,
    sender: { $ne: user._id },
    "readBy.user": { $ne: user._id },
  });

  for (const message of unreadMessages) {
    message.readBy.push({ user: user._id, readAt: new Date() });
    await message.save();
  }

  emitChatMessagesRead({
    jobId: toId(job._id),
    readerId: toId(user._id),
    markedCount: unreadMessages.length,
    participants: uniqueIds([job.fleet, job.assignedMechanic, job.assignedCompany]),
  });

  return {
    jobId: toId(job._id),
    markedCount: unreadMessages.length,
  };
};

/**
 * Upload a chat image for a job (returns HTTPS URL for use in POST …/messages `attachments`).
 */
export const uploadJobChatAttachment = async (jobId, user, file) => {
  await ensureChatAccess(jobId, user);
  if (!file?.buffer?.length) {
    throw new AppError("file is required (multipart field name: file)", 400);
  }
  const uploaded = await uploadChatAttachmentBuffer(file.buffer, file.mimetype);
  return {
    url: uploaded.url,
    width: uploaded.width,
    height: uploaded.height,
    publicId: uploaded.publicId,
    format: uploaded.format,
  };
};
