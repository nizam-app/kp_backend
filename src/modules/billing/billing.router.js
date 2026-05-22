import { Router } from "express";
import { catchAsync } from "../../utils/catchAsync.js";
import { authorize, protect } from "../../middlewares/auth.js";
import { ROLES } from "../../constants/domain.js";
import {
  attachStripePaymentMethodController,
  createPaymentMethodController,
  mechanicStripeDashboardLinkController,
  mechanicStripeOnboardingLinkController,
  mechanicStripePayoutAccountController,
  createStripeSetupIntentController,
  listPaymentMethodsController,
  removePaymentMethodController,
  setDefaultPaymentMethodController,
  stripeWebhookController,
  stripeBillingConfigController,
  syncStripePaymentIntentController,
} from "./billing.controller.js";

const router = Router();

router.post("/stripe/webhook", catchAsync(stripeWebhookController));

router.use(catchAsync(protect));

router.get("/stripe/config", catchAsync(stripeBillingConfigController));
router.post(
  "/stripe/setup-intent",
  catchAsync(authorize(ROLES.FLEET, ROLES.COMPANY)),
  catchAsync(createStripeSetupIntentController)
);
router.post(
  "/stripe/payment-intents/:paymentIntentId/sync",
  catchAsync(authorize(ROLES.FLEET, ROLES.COMPANY)),
  catchAsync(syncStripePaymentIntentController)
);
router.get(
  "/stripe/mechanic-payout-account",
  catchAsync(authorize(ROLES.MECHANIC)),
  catchAsync(mechanicStripePayoutAccountController)
);
router.post(
  "/stripe/mechanic-payout-account/onboarding-link",
  catchAsync(authorize(ROLES.MECHANIC)),
  catchAsync(mechanicStripeOnboardingLinkController)
);
router.post(
  "/stripe/mechanic-payout-account/dashboard-link",
  catchAsync(authorize(ROLES.MECHANIC)),
  catchAsync(mechanicStripeDashboardLinkController)
);
router.post(
  "/stripe/payment-methods/attach",
  catchAsync(authorize(ROLES.FLEET, ROLES.COMPANY)),
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
