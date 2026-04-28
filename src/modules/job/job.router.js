import { Router } from "express";
import { catchAsync } from "../../utils/catchAsync.js";
import { authorize, protect, requireActive } from "../../middlewares/auth.js";
import {
  addJobPhotosController,
  addJobAttachmentsController,
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
  removeJobPhotoController,
  removeJobAttachmentController,
  previewJobCancellationController,
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
router.get(
  "/:jobId/cancellation-preview",
  catchAsync(authorize(ROLES.FLEET)),
  catchAsync(previewJobCancellationController)
);
router.get("/:jobId", catchAsync(getJobByIdController));
router.post("/:jobId/photos", catchAsync(addJobPhotosController));
router.patch("/:jobId/photos/remove", catchAsync(removeJobPhotoController));
router.post("/:jobId/attachments", catchAsync(addJobAttachmentsController));
router.delete(
  "/:jobId/attachments/:attachmentId",
  catchAsync(removeJobAttachmentController)
);
router.patch(
  "/:jobId/cancel",
  catchAsync(authorize(ROLES.FLEET)),
  catchAsync(cancelJobController)
);
router.patch(
  "/:jobId/journey/start",
  catchAsync(authorize(ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE)),
  catchAsync(startJourneyController)
);
router.patch(
  "/:jobId/arrive",
  catchAsync(authorize(ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE)),
  catchAsync(arriveAtJobController)
);
router.patch(
  "/:jobId/work/start",
  catchAsync(authorize(ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE)),
  catchAsync(startWorkController)
);
router.patch(
  "/:jobId/work/complete",
  catchAsync(authorize(ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE)),
  catchAsync(completeWorkController)
);
router.patch(
  "/:jobId/complete/approve",
  catchAsync(authorize(ROLES.FLEET)),
  catchAsync(approveCompletionController)
);


router.post(
  "/:jobId/location-pings",
  catchAsync(authorize(ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE)),
  catchAsync(jobLocationPingController)
);
router.get(
  "/:jobId/timeline",
  catchAsync(jobTimelineController)
);
router.post(
  "/:jobId/quotes",
  catchAsync(authorize(ROLES.MECHANIC, ROLES.COMPANY, ROLES.MECHANIC_EMPLOYEE)),
  catchAsync(submitQuoteController)
);
router.get(
  "/:jobId/quotes",
  catchAsync(authorize(ROLES.FLEET)),
  catchAsync(listJobQuotesController)
);

export default router;


