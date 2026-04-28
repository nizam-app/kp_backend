import { Router } from "express";
import { catchAsync } from "../../utils/catchAsync.js";
import { authorize, protect, requireActive } from "../../middlewares/auth.js";
import { ROLES } from "../../constants/domain.js";
import {
  createFleetReviewController,
  getMechanicReviewByIdController,
  listFleetReviewsController,
  listMechanicReviewsController,
} from "./review.controller.js";

const router = Router();

router.use(catchAsync(protect));
router.use(catchAsync(requireActive));

router.get(
  "/",
  catchAsync(authorize(ROLES.FLEET)),
  catchAsync(listFleetReviewsController)
);
router.get(
  "/me",
  catchAsync(authorize(ROLES.MECHANIC)),
  catchAsync(listMechanicReviewsController)
);
router.get(
  "/me/:reviewId",
  catchAsync(authorize(ROLES.MECHANIC)),
  catchAsync(getMechanicReviewByIdController)
);
router.post(
  "/",
  catchAsync(authorize(ROLES.FLEET)),
  catchAsync(createFleetReviewController)
);

export default router;
