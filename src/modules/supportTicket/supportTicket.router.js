import { Router } from "express";
import { catchAsync } from "../../utils/catchAsync.js";
import { protect } from "../../middlewares/auth.js";
import {
  createSupportTicketController,
  listSupportTicketsController,
} from "./supportTicket.controller.js";

const router = Router();

router.use(catchAsync(protect));

router.get("/", catchAsync(listSupportTicketsController));
router.post("/", catchAsync(createSupportTicketController));

export default router;
