import { Router } from "express";
import { catchAsync } from "../../utils/catchAsync.js";
import { authorize, protect, requireActive } from "../../middlewares/auth.js";
import {
  approveCompletionController,
  arriveAtJobController,
  cancelJobController,
  completeWorkController,
  createJobController,
  getJobByIdController,
  listJobsController,
  startJourneyController,
  startWorkController,
  jobLocationPingController,
  jobTimelineController,
} from "./job.controller.js";
import {
  listJobQuotesController,
  submitQuoteController,
} from "../quote/quote.controller.js";
import { ROLES } from "../../constants/domain.js";

const router = Router();

router.use(catchAsync(protect));
router.use(catchAsync(requireActive));

router.post("/", catchAsync(authorize(ROLES.FLEET)), catchAsync(createJobController));
router.get("/", catchAsync(listJobsController));
router.get("/:jobId", catchAsync(getJobByIdController));
router.patch(
  "/:jobId/cancel",
  catchAsync(authorize(ROLES.FLEET)),
  catchAsync(cancelJobController)
);
router.patch(
  "/:jobId/journey/start",
  catchAsync(authorize(ROLES.MECHANIC)),
  catchAsync(startJourneyController)
);
router.patch(
  "/:jobId/arrive",
  catchAsync(authorize(ROLES.MECHANIC)),
  catchAsync(arriveAtJobController)
);
router.patch(
  "/:jobId/work/start",
  catchAsync(authorize(ROLES.MECHANIC)),
  catchAsync(startWorkController)
);
router.patch(
  "/:jobId/work/complete",
  catchAsync(authorize(ROLES.MECHANIC)),
  catchAsync(completeWorkController)
);
router.patch(
  "/:jobId/complete/approve",
  catchAsync(authorize(ROLES.FLEET)),
  catchAsync(approveCompletionController)
);


router.post(
  "/:jobId/location-pings",
  catchAsync(authorize(ROLES.MECHANIC)),
  catchAsync(jobLocationPingController)
);
router.get(
  "/:jobId/timeline",
  catchAsync(jobTimelineController)
);
router.post(
  "/:jobId/quotes",
  catchAsync(authorize(ROLES.MECHANIC)),
  catchAsync(submitQuoteController)
);
router.get(
  "/:jobId/quotes",
  catchAsync(authorize(ROLES.FLEET)),
  catchAsync(listJobQuotesController)
);

export default router;


