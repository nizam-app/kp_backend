import { Router } from "express";
import { catchAsync } from "../../utils/catchAsync.js";
import { protect } from "../../middlewares/auth.js";
import {
  createPaymentMethodController,
  listPaymentMethodsController,
  removePaymentMethodController,
  setDefaultPaymentMethodController,
} from "./billing.controller.js";

const router = Router();

router.use(catchAsync(protect));

router.get("/payment-methods", catchAsync(listPaymentMethodsController));
router.post("/payment-methods", catchAsync(createPaymentMethodController));
router.patch(
  "/payment-methods/:methodId/default",
  catchAsync(setDefaultPaymentMethodController)
);
router.delete(
  "/payment-methods/:methodId",
  catchAsync(removePaymentMethodController)
);

export default router;
