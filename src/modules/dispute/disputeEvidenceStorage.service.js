import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import AppError from "../../utils/AppError.js";
import {
  cloudinary,
  isCloudinaryConfigured,
} from "../../config/cloudinary.js";

const root = path.resolve(process.cwd(), "private_uploads", "disputes");

export const detectEvidenceMime = (buffer) => {
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46
  ) return "application/pdf";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) return "image/png";
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString() === "RIFF" &&
    buffer.subarray(8, 12).toString() === "WEBP"
  ) return "image/webp";
  return null;
};

const uploadCloudinary = (buffer, publicId) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        public_id: publicId,
        type: "authenticated",
        resource_type: "auto",
        overwrite: false,
      },
      (error, result) => (error ? reject(error) : resolve(result))
    );
    stream.end(buffer);
  });

export const storePrivateEvidence = async ({ disputeId, file }) => {
  if (!file?.buffer?.length) throw new AppError("Evidence file is required", 400);
  const mimeType = detectEvidenceMime(file.buffer);
  if (!mimeType || mimeType !== `${file.mimetype || ""}`.toLowerCase()) {
    throw new AppError("File content does not match an allowed MIME type", 400);
  }
  const sha256 = crypto.createHash("sha256").update(file.buffer).digest("hex");
  const token = crypto.randomBytes(16).toString("hex");

  if (process.env.NODE_ENV === "production" && isCloudinaryConfigured()) {
    const publicId = `truckfix/disputes/${disputeId}/${token}`;
    const uploaded = await uploadCloudinary(file.buffer, publicId);
    return {
      storageKey: `cloudinary:${uploaded.resource_type}:${uploaded.public_id}`,
      mimeType,
      size: file.size,
      sha256,
      scanStatus: "PENDING",
    };
  }

  const directory = path.join(root, `${disputeId}`);
  await fs.mkdir(directory, { recursive: true });
  const storageKey = `local:${disputeId}/${token}`;
  await fs.writeFile(path.join(directory, token), file.buffer, { flag: "wx" });
  return {
    storageKey,
    mimeType,
    size: file.size,
    sha256,
    scanStatus: "PENDING",
  };
};

export const resolvePrivateEvidence = async (storageKey) => {
  if (`${storageKey}`.startsWith("local:")) {
    const relative = `${storageKey}`.slice("local:".length);
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(`${root}${path.sep}`)) {
      throw new AppError("Invalid evidence storage key", 400);
    }
    await fs.access(absolute);
    return { kind: "file", path: absolute };
  }
  if (`${storageKey}`.startsWith("cloudinary:")) {
    const [, resourceType, ...publicIdParts] = `${storageKey}`.split(":");
    const publicId = publicIdParts.join(":");
    return {
      kind: "redirect",
      url: cloudinary.url(publicId, {
        type: "authenticated",
        resource_type: resourceType,
        sign_url: true,
        secure: true,
        expires_at: Math.floor(Date.now() / 1000) + 300,
      }),
    };
  }
  throw new AppError("Evidence storage is unavailable", 404);
};
