import { Router } from "express";
import { catchAsync } from "../../utils/catchAsync.js";
import { validateCompanyInviteController } from "./company.controller.js";

const router = Router();

router.get("/invites/validate", catchAsync(validateCompanyInviteController));

export default router;
