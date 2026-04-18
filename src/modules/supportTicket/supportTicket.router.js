import { Router } from "express";
import { catchAsync } from "../../utils/catchAsync.js";
import { protect } from "../../middlewares/auth.js";
import {
  addSupportTicketReplyController,
  createSupportTicketController,
  getSupportTicketByIdController,
  listSupportTicketsController,
  updateSupportTicketController,
} from "./supportTicket.controller.js";

const router = Router();

router.use(catchAsync(protect));

router.get("/", catchAsync(listSupportTicketsController));
router.post("/", catchAsync(createSupportTicketController));
router.get("/:ticketId", catchAsync(getSupportTicketByIdController));
router.patch("/:ticketId", catchAsync(updateSupportTicketController));
router.post("/:ticketId/replies", catchAsync(addSupportTicketReplyController));

export default router;
