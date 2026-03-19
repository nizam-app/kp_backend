import { Router } from "express";
import authRouter from "../modules/auth/auth.router.js";
import userRouter from "../modules/user/user.router.js";
import jobRouter from "../modules/job/job.router.js";
import quoteRouter from "../modules/quote/quote.router.js";
import vehicleRouter from "../modules/vehicle/vehicle.router.js";
import fleetRouter from "../modules/fleet/fleet.router.js";

const router = Router();

router.use("/auth", authRouter);
router.use("/users", userRouter);
router.use("/jobs", jobRouter);
router.use("/quotes", quoteRouter);
router.use("/fleet/vehicles", vehicleRouter);
router.use("/fleet", fleetRouter);

export default router;
