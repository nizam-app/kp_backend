import { sendResponse } from "../../utils/sendResponse.js";
import {
  listChatThreads,
  listJobMessages,
  markJobMessagesRead,
  sendJobMessage,
} from "./chat.service.js";

export const listChatThreadsController = async (req, res) => {
  const result = await listChatThreads(req.user, req.query);
  return sendResponse(res, {
    message: "Chat threads fetched",
    data: result.items,
    meta: result.meta,
  });
};

export const listJobMessagesController = async (req, res) => {
  const result = await listJobMessages(req.params.jobId, req.user, req.query);
  return sendResponse(res, {
    message: "Job messages fetched",
    data: result,
  });
};

export const sendJobMessageController = async (req, res) => {
  const message = await sendJobMessage(req.params.jobId, req.user, req.body);
  return sendResponse(res, {
    statusCode: 201,
    message: "Message sent",
    data: message,
  });
};

export const markJobMessagesReadController = async (req, res) => {
  const result = await markJobMessagesRead(req.params.jobId, req.user);
  return sendResponse(res, {
    message: "Messages marked as read",
    data: result,
  });
};
