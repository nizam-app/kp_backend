import multer from "multer";

/** Shared multer config for profile image uploads (field name: `file`). */
export const profileImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith("image/")) {
      return cb(null, true);
    }
    cb(new Error("Only image uploads are allowed"));
  },
});

export const handleProfileImageMulterError = (req, res, next) => {
  profileImageUpload.single("file")(req, res, (err) => {
    if (err) {
      return res.status(400).json({
        status: "error",
        message: err.message || "File upload error",
      });
    }
    next();
  });
};
