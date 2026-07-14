import { Router } from "express";
import { catchAsync } from "../../utils/catchAsync.js";
import { authorize, protect } from "../../middlewares/auth.js";
import {
  acceptTermsController,
  acceptMyCompanyInviteController,
  declineMyCompanyInviteController,
  deleteMeController,
  getMe,
  listMyCompanyInvitesController,
  updateMechanicAvailabilityController,
  updateMe,
  updatePreferencesController,
} from "./user.controller.js";
import { ROLES } from "../../constants/domain.js";

const router = Router();

router.use(catchAsync(protect));
router.get("/me", catchAsync(getMe));
router.patch("/me", catchAsync(updateMe));
router.delete(
  "/me",
  catchAsync(
    authorize(ROLES.FLEET, ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE, ROLES.COMPANY)
  ),
  catchAsync(deleteMeController)
);
router.patch("/me/preferences", catchAsync(updatePreferencesController));
router.patch("/me/terms", catchAsync(acceptTermsController));
router.patch(
  "/me/availability",
  catchAsync(authorize(ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE)),
  catchAsync(updateMechanicAvailabilityController)
);
router.patch(
  "/mechanic/availability",
  catchAsync(authorize(ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE)),
  catchAsync(updateMechanicAvailabilityController)
);

router.get(
  "/me/company-invites",
  catchAsync(authorize(ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE)),
  catchAsync(listMyCompanyInvitesController)
);
router.post(
  "/me/company-invites/:inviteId/accept",
  catchAsync(authorize(ROLES.MECHANIC)),
  catchAsync(acceptMyCompanyInviteController)
);
router.post(
  "/me/company-invites/:inviteId/decline",
  catchAsync(authorize(ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE)),
  catchAsync(declineMyCompanyInviteController)
);

export default router;
