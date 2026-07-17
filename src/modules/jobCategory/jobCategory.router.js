import { Router } from "express";
import { protect, requireActive } from "../../middlewares/auth.js";
import { catchAsync } from "../../utils/catchAsync.js";
import { listActiveJobCategoriesController } from "./jobCategory.controller.js";

const router = Router();

router.use(catchAsync(protect));
router.use(catchAsync(requireActive));
router.get("/", catchAsync(listActiveJobCategoriesController));

export default router;
