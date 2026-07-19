import multer from "multer";

export const disputeEvidenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

export const handleDisputeEvidenceUpload = (req, res, next) => {
  disputeEvidenceUpload.single("file")(req, res, (error) => {
    if (error) {
      return res.status(400).json({
        status: "error",
        message: error.message || "Evidence upload failed",
      });
    }
    next();
  });
};
