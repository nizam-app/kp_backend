import { Router } from "express";
import { catchAsync } from "../../utils/catchAsync.js";
import { protect } from "../../middlewares/auth.js";
import {
  attachStripePaymentMethodController,
  createPaymentMethodController,
  createStripeSetupIntentController,
  listPaymentMethodsController,
  removePaymentMethodController,
  setDefaultPaymentMethodController,
  stripeBillingConfigController,
} from "./billing.controller.js";

const router = Router();

router.use(catchAsync(protect));

router.get("/stripe/config", catchAsync(stripeBillingConfigController));
router.post("/stripe/setup-intent", catchAsync(createStripeSetupIntentController));
router.post(
  "/stripe/payment-methods/attach",
  catchAsync(attachStripePaymentMethodController)
);
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
