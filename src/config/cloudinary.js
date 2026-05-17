import { v2 as cloudinary } from "cloudinary";

const trim = (v) => `${v ?? ""}`.trim();

/**
 * Cloudinary reads `CLOUDINARY_URL` automatically when set.
 * Otherwise set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`.
 */
export const isCloudinaryConfigured = () =>
  Boolean(
    trim(process.env.CLOUDINARY_URL) ||
      (trim(process.env.CLOUDINARY_CLOUD_NAME) &&
        trim(process.env.CLOUDINARY_API_KEY) &&
        trim(process.env.CLOUDINARY_API_SECRET))
  );

export const initCloudinary = () => {
  const url = trim(process.env.CLOUDINARY_URL);
  const cloudName = trim(process.env.CLOUDINARY_CLOUD_NAME);
  const apiKey = trim(process.env.CLOUDINARY_API_KEY);
  const apiSecret = trim(process.env.CLOUDINARY_API_SECRET);

  if (url) {
    process.env.CLOUDINARY_URL = url;
    // Reload SDK config from process.env (fixes stale empty config if env loaded late).
    cloudinary.config(true);
    return;
  }
  if (cloudName && apiKey && apiSecret) {
    cloudinary.config({
      cloud_name: cloudName,
      api_key: apiKey,
      api_secret: apiSecret,
    });
  }
};

initCloudinary();

export { cloudinary };
