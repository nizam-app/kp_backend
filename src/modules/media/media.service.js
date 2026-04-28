import { Readable } from "stream";
import AppError from "../../utils/AppError.js";
import { cloudinary, isCloudinaryConfigured, initCloudinary } from "../../config/cloudinary.js";

const PROFILE_FOLDER = "truckfix/profiles";

const ensureConfig = () => {
  initCloudinary();
  if (!isCloudinaryConfigured()) {
    throw new AppError(
      "Image upload is not configured. Set CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET.",
      503
    );
  }
};

/**
 * Upload a raw image buffer to Cloudinary.
 * @returns {Promise<{ url: string, publicId: string, width: number, height: number }>}
 */
export const uploadProfileImageBuffer = async (buffer, mimetype) => {
  ensureConfig();
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new AppError("Empty file", 400);
  }

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: PROFILE_FOLDER,
        resource_type: "image",
        allowed_formats: ["jpg", "png", "webp", "gif", "heic"],
        use_filename: false,
        unique_filename: true,
      },
      (err, result) => {
        if (err) {
          reject(new AppError(err.message || "Cloudinary upload failed", 502));
          return;
        }
        if (!result?.secure_url) {
          reject(new AppError("No URL returned from Cloudinary", 502));
          return;
        }
        resolve({
          url: result.secure_url,
          publicId: result.public_id,
          width: result.width,
          height: result.height,
          format: result.format,
          mimetype: mimetype || null,
        });
      }
    );
    Readable.from(buffer).pipe(stream);
  });
};
