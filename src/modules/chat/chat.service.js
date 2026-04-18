import AppError from "../../utils/AppError.js";
import { ChatMessage } from "./chat.model.js";
import { Job } from "../job/job.model.js";
import { JobEvent } from "../jobEvent/jobEvent.model.js";
import { ROLES } from "../../constants/domain.js";
import { createNotification } from "../notification/notification.service.js";
import {
  emitChatMessage,
  emitChatMessagesRead,
} from "../../realtime/socket.js";

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
      }
    : null,
  text: message.text,
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
    .populate("fleet", "email role fleetProfile.companyName fleetProfile.contactName")
    .populate(
      "assignedMechanic",
      "email role mechanicProfile.displayName mechanicProfile.businessName"
    );

  if (!job) throw new AppError("Job not found", 404);
  if (user.role === ROLES.ADMIN) return job;

  const userId = toId(user._id);
  const fleetId = toId(job.fleet);
  const mechanicId = toId(job.assignedMechanic);

  if (user.role === ROLES.FLEET && fleetId === userId) return job;
  if (user.role === ROLES.MECHANIC && mechanicId === userId) return job;

  throw new AppError("Forbidden", 403);
};

const buildCounterparty = (job, user) => {
  if (user.role === ROLES.FLEET) {
    return job.assignedMechanic
      ? {
          _id: toId(job.assignedMechanic),
          role: job.assignedMechanic.role,
          label: participantLabel(job.assignedMechanic),
        }
      : null;
  }

  return job.fleet
    ? {
        _id: toId(job.fleet),
        role: job.fleet.role,
        label: participantLabel(job.fleet),
      }
    : null;
};

export const listChatThreads = async (user, query = {}) => {
  const page = parsePage(query.page);
  const limit = parseLimit(query.limit, 20, 50);
  const skip = (page - 1) * limit;

  const jobFilter = {};
  if (user.role === ROLES.FLEET) jobFilter.fleet = user._id;
  if (user.role === ROLES.MECHANIC) jobFilter.assignedMechanic = user._id;

  const jobs = await Job.find(jobFilter)
    .sort({ updatedAt: -1, createdAt: -1 })
    .populate("fleet", "email role fleetProfile.companyName fleetProfile.contactName")
    .populate(
      "assignedMechanic",
      "email role mechanicProfile.displayName mechanicProfile.businessName"
    )
    .lean();

  const jobIds = jobs.map((job) => job._id);
  const messages = await ChatMessage.find({ job: { $in: jobIds } })
    .sort({ createdAt: -1 })
    .populate("sender", "email role fleetProfile.companyName fleetProfile.contactName mechanicProfile.displayName mechanicProfile.businessName")
    .lean();

  const threads = jobs
    .map((job) => {
      const threadMessages = messages.filter((message) => toId(message.job) === toId(job._id));
      const lastMessage = threadMessages[0] || null;
      const unreadCount = threadMessages.filter((message) => {
        const senderId = toId(message.sender);
        const isRead = (message.readBy || []).some((item) => toId(item.user) === toId(user._id));
        return senderId !== toId(user._id) && !isRead;
      }).length;

      return {
        job: {
          _id: job._id,
          jobCode: job.jobCode,
          title: job.title,
          status: job.status,
          vehicle: job.vehicle || null,
          location: job.location || null,
        },
        counterparty: buildCounterparty(job, user),
        unreadCount,
        lastMessage: lastMessage ? serializeMessage(lastMessage, toId(user._id)) : null,
        updatedAt: lastMessage?.createdAt || job.updatedAt || job.createdAt,
      };
    })
    .filter((thread) => thread.counterparty)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  const paged = threads.slice(skip, skip + limit);

  return {
    items: paged,
    meta: {
      page,
      limit,
      total: threads.length,
      totalPages: Math.ceil(threads.length / limit) || 1,
      unreadThreads: threads.filter((item) => item.unreadCount > 0).length,
    },
  };
};

export const listJobMessages = async (jobId, user, query = {}) => {
  const job = await ensureChatAccess(jobId, user);
  const limit = parseLimit(query.limit, 50, 200);

  const messages = await ChatMessage.find({ job: job._id })
    .sort({ createdAt: 1 })
    .limit(limit)
    .populate(
      "sender",
      "email role fleetProfile.companyName fleetProfile.contactName mechanicProfile.displayName mechanicProfile.businessName"
    );

  return {
    job: {
      _id: job._id,
      jobCode: job.jobCode,
      title: job.title,
      status: job.status,
      location: job.location || null,
    },
    counterparty: buildCounterparty(job, user),
    items: messages.map((message) => serializeMessage(message, toId(user._id))),
  };
};

export const sendJobMessage = async (jobId, user, payload = {}) => {
  const job = await ensureChatAccess(jobId, user);
  const text = `${payload.text || ""}`.trim();
  if (!text) throw new AppError("text is required", 400);

  const recipient =
    user.role === ROLES.FLEET ? job.assignedMechanic : job.fleet;
  if (!recipient) {
    throw new AppError("No chat recipient is available for this job", 400);
  }

  const message = await ChatMessage.create({
    job: job._id,
    sender: user._id,
    text,
    attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
    readBy: [{ user: user._id, readAt: new Date() }],
  });

  await createNotification({
    user: recipient._id || recipient,
    type: "CHAT_MESSAGE",
    title: `New job message for ${job.jobCode}`,
    body: text.length > 120 ? `${text.slice(0, 117)}...` : text,
    data: {
      jobId: toId(job._id),
      jobCode: job.jobCode,
      senderId: toId(user._id),
    },
  });

  await JobEvent.create({
    job: job._id,
    actor: user._id,
    type: "CHAT_MESSAGE_SENT",
    note: text,
    payload: {
      textLength: text.length,
    },
  });

  const populated = await ChatMessage.findById(message._id).populate(
    "sender",
    "email role fleetProfile.companyName fleetProfile.contactName mechanicProfile.displayName mechanicProfile.businessName"
  );

  const serialized = serializeMessage(populated, toId(user._id));
  emitChatMessage({
    jobId: toId(job._id),
    message: serialized,
    participants: [toId(job.fleet), toId(job.assignedMechanic)],
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
    participants: [toId(job.fleet), toId(job.assignedMechanic)],
  });

  return {
    jobId: toId(job._id),
    markedCount: unreadMessages.length,
  };
};
