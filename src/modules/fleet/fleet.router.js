import { Router } from "express";
import { authorize, protect, requireActive } from "../../middlewares/auth.js";
import { catchAsync } from "../../utils/catchAsync.js";
import { ROLES } from "../../constants/domain.js";
import { fleetDashboardController } from "./fleet.controller.js";

const router = Router();

router.use(catchAsync(protect));
router.use(catchAsync(requireActive));
router.use(catchAsync(authorize(ROLES.FLEET)));

router.get("/dashboard", catchAsync(fleetDashboardController));

export default router;
