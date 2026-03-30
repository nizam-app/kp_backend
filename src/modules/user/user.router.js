import { Router } from "express";
import { catchAsync } from "../../utils/catchAsync.js";
import { authorize, protect } from "../../middlewares/auth.js";
import {
  acceptTermsController,
  getMe,
  updateMechanicAvailabilityController,
  updateMe,
  updatePreferencesController,
} from "./user.controller.js";
import { ROLES } from "../../constants/domain.js";

const router = Router();

router.use(catchAsync(protect));
router.get("/me", catchAsync(getMe));
router.patch("/me", catchAsync(updateMe));
router.patch("/me/preferences", catchAsync(updatePreferencesController));
router.patch("/me/terms", catchAsync(acceptTermsController));
router.patch(
  "/me/availability",
  catchAsync(authorize(ROLES.MECHANIC)),
  catchAsync(updateMechanicAvailabilityController)
);
router.patch(
  "/mechanic/availability",
  catchAsync(authorize(ROLES.MECHANIC)),
  catchAsync(updateMechanicAvailabilityController)
);

export default router;
