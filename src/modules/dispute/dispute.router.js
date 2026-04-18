import { Router } from "express";
import { catchAsync } from "../../utils/catchAsync.js";
import { authorize, protect, requireActive } from "../../middlewares/auth.js";
import { ROLES } from "../../constants/domain.js";
import {
  createFleetDisputeController,
  listMechanicDisputesController,
  listFleetDisputesController,
  updateMechanicDisputeController,
  updateFleetDisputeController,
} from "./dispute.controller.js";

const router = Router();

router.use(catchAsync(protect));
router.use(catchAsync(requireActive));

router.get(
  "/",
  catchAsync(authorize(ROLES.FLEET)),
  catchAsync(listFleetDisputesController)
);
router.get(
  "/me",
  catchAsync(authorize(ROLES.MECHANIC)),
  catchAsync(listMechanicDisputesController)
);
router.post(
  "/",
  catchAsync(authorize(ROLES.FLEET)),
  catchAsync(createFleetDisputeController)
);
router.patch(
  "/:disputeId",
  catchAsync(authorize(ROLES.FLEET)),
  catchAsync(updateFleetDisputeController)
);
router.patch(
  "/me/:disputeId",
  catchAsync(authorize(ROLES.MECHANIC)),
  catchAsync(updateMechanicDisputeController)
);

export default router;
