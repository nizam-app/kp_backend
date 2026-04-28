import { Router } from "express";
import { catchAsync } from "../../utils/catchAsync.js";
import { authorize, protect, requireActive } from "../../middlewares/auth.js";
import { ROLES } from "../../constants/domain.js";
import {
  createFeedPresetController,
  deleteFeedPresetController,
  listFeedPresetsController,
  updateFeedPresetController,
} from "./feedPreset.controller.js";

const router = Router();

router.use(catchAsync(protect));
router.use(catchAsync(requireActive));
router.use(
  catchAsync(
    authorize(
      ROLES.MECHANIC,
      ROLES.FLEET,
      ROLES.COMPANY,
      ROLES.MECHANIC_EMPLOYEE
    )
  )
);

router.get("/", catchAsync(listFeedPresetsController));
router.post("/", catchAsync(createFeedPresetController));
router.patch("/:presetId", catchAsync(updateFeedPresetController));
router.delete("/:presetId", catchAsync(deleteFeedPresetController));

export default router;
