import { Router } from "express";
import { catchAsync } from "../../utils/catchAsync.js";
import { authorize, protect, requireActive } from "../../middlewares/auth.js";
import {
  acceptQuoteController,
  amendQuoteController,
  declineQuoteController,
  getQuoteByIdController,
  listMyQuotesController,
  withdrawQuoteController,
} from "./quote.controller.js";
import { ROLES } from "../../constants/domain.js";

const router = Router();

router.use(catchAsync(protect));
router.use(catchAsync(requireActive));

router.get(
  "/me",
  catchAsync(authorize(ROLES.MECHANIC, ROLES.COMPANY, ROLES.MECHANIC_EMPLOYEE)),
  catchAsync(listMyQuotesController)
);
router.get("/:quoteId", catchAsync(getQuoteByIdController));
router.patch(
  "/:quoteId/amend",
  catchAsync(authorize(ROLES.MECHANIC, ROLES.COMPANY, ROLES.MECHANIC_EMPLOYEE)),
  catchAsync(amendQuoteController)
);
router.patch(
  "/:quoteId/withdraw",
  catchAsync(authorize(ROLES.MECHANIC, ROLES.COMPANY, ROLES.MECHANIC_EMPLOYEE)),
  catchAsync(withdrawQuoteController)
);
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
