import { Router } from "express";
import { catchAsync } from "../../utils/catchAsync.js";
import { authorize, protect, requireActive } from "../../middlewares/auth.js";
import {
  acceptQuoteController,
  declineQuoteController,
  getQuoteByIdController,
  listMyQuotesController,
} from "./quote.controller.js";
import { ROLES } from "../../constants/domain.js";

const router = Router();

router.use(catchAsync(protect));
router.use(catchAsync(requireActive));

router.get("/me", catchAsync(authorize(ROLES.MECHANIC)), catchAsync(listMyQuotesController));
router.get("/:quoteId", catchAsync(getQuoteByIdController));
router.patch(
  "/:quoteId/accept",
  catchAsync(authorize(ROLES.FLEET)),
  catchAsync(acceptQuoteController)
);
router.patch(
  "/:quoteId/decline",
  catchAsync(authorize(ROLES.FLEET)),
  catchAsync(declineQuoteController)
);

export default router;
