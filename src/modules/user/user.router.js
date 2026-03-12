import { Router } from "express";
import { catchAsync } from "../../utils/catchAsync.js";
import { authorize, protect } from "../../middlewares/auth.js";
import { getMe, updateMe } from "./user.controller.js";

const router = Router();

router.use(catchAsync(protect));
router.get("/me", catchAsync(getMe));
router.patch("/me", catchAsync(updateMe));
router.patch("/mechanic/availability", catchAsync(authorize("MECHANIC")), catchAsync(updateMe));

export default router;
