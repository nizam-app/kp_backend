import { Router } from "express";
import { authorize, protect, requireActive } from "../../middlewares/auth.js";
import { catchAsync } from "../../utils/catchAsync.js";
import { ROLES } from "../../constants/domain.js";
import {
  createVehicleController,
  listVehiclesController,
  updateVehicleController,
} from "./vehicle.controller.js";

const router = Router();

router.use(catchAsync(protect));
router.use(catchAsync(requireActive));
router.use(catchAsync(authorize(ROLES.FLEET)));

router.post("/", catchAsync(createVehicleController));
router.get("/", catchAsync(listVehiclesController));
router.patch("/:vehicleId", catchAsync(updateVehicleController));

export default router;
