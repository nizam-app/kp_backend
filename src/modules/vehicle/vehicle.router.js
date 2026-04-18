import { Router } from "express";
import { authorize, protect, requireActive } from "../../middlewares/auth.js";
import { catchAsync } from "../../utils/catchAsync.js";
import { ROLES } from "../../constants/domain.js";
import {
  createVehicleController,
  deleteVehicleController,
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
router.delete("/:vehicleId", catchAsync(deleteVehicleController));

export default router;
