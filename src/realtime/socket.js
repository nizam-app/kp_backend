import { Server } from "socket.io";
import { verifyAccessToken } from "../utils/token.js";
import { User } from "../modules/user/user.model.js";
import { Job } from "../modules/job/job.model.js";
import { ROLES, USER_STATUS } from "../constants/domain.js";

let ioInstance = null;

const userRoom = (userId) => `user:${userId}`;
const roleRoom = (role) => `role:${role}`;
const jobRoom = (jobId) => `job:${jobId}`;

const toId = (value) => (value?._id || value)?.toString?.() || null;

const uniqueIds = (values = []) => [...new Set(values.map(toId).filter(Boolean))];

const parseSocketToken = (socket) => {
  const authToken = socket.handshake.auth?.token || socket.handshake.auth?.accessToken;
  if (authToken) return `${authToken}`.trim();

  const header = `${socket.handshake.headers?.authorization || ""}`.trim();
  if (header.startsWith("Bearer ")) return header.slice(7).trim();

  const queryToken = socket.handshake.query?.token;
  if (queryToken) return `${queryToken}`.trim();

  return null;
};

const canAccessJob = async (jobId, user) => {
  const job = await Job.findById(jobId).select("fleet assignedMechanic assignedCompany");
  if (!job) return false;
  if (user.role === ROLES.ADMIN) return true;

  const userId = toId(user._id);
  const companyId = toId(user.companyMembership?.company);
  return (
    toId(job.fleet) === userId ||
    toId(job.assignedMechanic) === userId ||
    toId(job.assignedCompany) === userId ||
    (companyId && toId(job.assignedCompany) === companyId)
  );
};

const serializeNotificationRealtime = (notification) => ({
  _id: notification._id,
  type: notification.type,
  title: notification.title,
  body: notification.body,
  data: notification.data || null,
  isRead: notification.isRead,
  readAt: notification.readAt || null,
  createdAt: notification.createdAt,
});

export const initRealtimeServer = (httpServer) => {
  ioInstance = new Server(httpServer, {
    cors: {
      origin: true,
      credentials: true,
    },
  });

  ioInstance.use(async (socket, next) => {
    try {
      const token = parseSocketToken(socket);
      if (!token) return next(new Error("Unauthorized"));

      const decoded = verifyAccessToken(token);
      const user = await User.findById(decoded.sub).select(
        "_id role status email companyMembership.company"
      );
      if (!user) return next(new Error("User not found"));
      if ([USER_STATUS.BLOCKED, USER_STATUS.SUSPENDED].includes(user.status)) {
        return next(new Error("Account is not active"));
      }

      socket.data.user = {
        _id: user._id.toString(),
        role: user.role,
        email: user.email,
        companyMembership: user.companyMembership || null,
      };
      next();
    } catch (error) {
      next(new Error("Unauthorized"));
    }
  });

  ioInstance.on("connection", (socket) => {
    const user = socket.data.user;
    socket.join(userRoom(user._id));
    socket.join(roleRoom(user.role));

    socket.emit("session:ready", {
      user: {
        _id: user._id,
        role: user.role,
        email: user.email,
      },
    });

    socket.on("job:subscribe", async (payload = {}, ack) => {
      try {
        const jobId = `${payload.jobId || ""}`.trim();
        if (!jobId) throw new Error("jobId is required");
        const allowed = await canAccessJob(jobId, user);
        if (!allowed) throw new Error("Forbidden");
        socket.join(jobRoom(jobId));
        ack?.({ ok: true, room: jobRoom(jobId) });
      } catch (error) {
        ack?.({ ok: false, error: error.message || "Unable to subscribe" });
      }
    });

    socket.on("job:unsubscribe", (payload = {}, ack) => {
      const jobId = `${payload.jobId || ""}`.trim();
      if (!jobId) {
        ack?.({ ok: false, error: "jobId is required" });
        return;
      }
      socket.leave(jobRoom(jobId));
      ack?.({ ok: true });
    });

    /** Typing indicator for job-scoped chat (mechanic ↔ fleet) */
    socket.on("chat:typing", async (payload = {}, ack) => {
      try {
        const jobId = `${payload.jobId || ""}`.trim();
        if (!jobId) throw new Error("jobId is required");
        const allowed = await canAccessJob(jobId, user);
        if (!allowed) throw new Error("Forbidden");
        socket.to(jobRoom(jobId)).emit("chat:typing", {
          jobId,
          userId: user._id,
          role: user.role,
          typing: Boolean(payload.typing),
        });
        ack?.({ ok: true });
      } catch (error) {
        ack?.({ ok: false, error: error.message || "Unable to send typing" });
      }
    });
  });

  return ioInstance;
};

export const getRealtimeIO = () => ioInstance;

export const emitNotificationCreated = (notification) => {
  if (!ioInstance || !notification?.user) return;
  ioInstance
    .to(userRoom(toId(notification.user)))
    .emit("notification:new", serializeNotificationRealtime(notification));
};

export const emitNotificationRead = ({ userId, notificationId, readAt }) => {
  if (!ioInstance || !userId || !notificationId) return;
  ioInstance.to(userRoom(`${userId}`)).emit("notification:read", {
    notificationId: `${notificationId}`,
    readAt: readAt || new Date(),
  });
};

export const emitJobPosted = (job) => {
  if (!ioInstance || !job?._id) return;
  const payload = {
    jobId: toId(job._id),
    jobCode: job.jobCode || null,
    title: job.title || null,
    status: job.status || null,
    urgency: job.urgency || null,
    issueType: job.issueType || null,
    location: job.location || null,
    estimatedPayout: job.estimatedPayout ?? null,
    createdAt: job.createdAt || new Date(),
  };

  [ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE, ROLES.COMPANY].forEach((role) => {
    ioInstance.to(roleRoom(role)).emit("job:posted", payload);
  });
};

export const emitJobStatusChanged = (job, payload = {}) => {
  if (!ioInstance || !job?._id) return;

  const eventPayload = {
    jobId: toId(job._id),
    jobCode: job.jobCode || null,
    status: job.status || null,
    tracking: job.tracking || null,
    completedAt: job.completedAt || null,
    cancelledAt: job.cancelledAt || null,
    ...payload,
  };

  ioInstance.to(jobRoom(toId(job._id))).emit("job:statusChanged", eventPayload);

  const recipients = uniqueIds([job.fleet, job.assignedMechanic, job.assignedCompany]);
  recipients.forEach((recipient) => {
    ioInstance.to(userRoom(recipient)).emit("job:statusChanged", eventPayload);
  });
};

export const emitJobLocationPing = (job, payload = {}) => {
  if (!ioInstance || !job?._id) return;

  const eventPayload = {
    jobId: toId(job._id),
    jobCode: job.jobCode || null,
    tracking: job.tracking || null,
    ...payload,
  };

  ioInstance.to(jobRoom(toId(job._id))).emit("job:location", eventPayload);

  const recipients = uniqueIds([job.fleet, job.assignedMechanic, job.assignedCompany]);
  recipients.forEach((recipient) => {
    ioInstance.to(userRoom(recipient)).emit("job:location", eventPayload);
  });
};

export const emitJobEvent = ({ jobId, event, recipients = [] }) => {
  if (!ioInstance || !jobId || !event) return;
  ioInstance.to(jobRoom(`${jobId}`)).emit("job:event", event);
  recipients.filter(Boolean).forEach((recipient) => {
    ioInstance.to(userRoom(`${recipient}`)).emit("job:event", event);
  });
};

export const emitChatMessage = ({ jobId, message, participants = [] }) => {
  if (!ioInstance || !jobId || !message) return;
  ioInstance.to(jobRoom(`${jobId}`)).emit("chat:message", {
    jobId: `${jobId}`,
    message,
  });
  participants.filter(Boolean).forEach((participant) => {
    ioInstance.to(userRoom(`${participant}`)).emit("chat:message", {
      jobId: `${jobId}`,
      message,
    });
  });
};

export const emitChatMessagesRead = ({ jobId, readerId, markedCount, participants = [] }) => {
  if (!ioInstance || !jobId || !readerId) return;
  const payload = {
    jobId: `${jobId}`,
    readerId: `${readerId}`,
    markedCount: Number(markedCount) || 0,
  };
  ioInstance.to(jobRoom(`${jobId}`)).emit("chat:read", payload);
  participants.filter(Boolean).forEach((participant) => {
    ioInstance.to(userRoom(`${participant}`)).emit("chat:read", payload);
  });
};
