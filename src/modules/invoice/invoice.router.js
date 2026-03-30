import { Router } from "express";
import { catchAsync } from "../../utils/catchAsync.js";
import { protect } from "../../middlewares/auth.js";
import {
  getInvoiceByIdController,
  getInvoiceDownloadController,
  listInvoicesController,
} from "./invoice.controller.js";

const router = Router();

router.use(catchAsync(protect));

router.get("/", catchAsync(listInvoicesController));
router.get("/:invoiceId", catchAsync(getInvoiceByIdController));
router.get("/:invoiceId/download", catchAsync(getInvoiceDownloadController));

export default router;
