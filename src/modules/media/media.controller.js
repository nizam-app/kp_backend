import { sendResponse } from "../../utils/sendResponse.js";
import { uploadProfileImageBuffer } from "./media.service.js";

/**
 * Multipart field name: "file" (e.g. FormData.append("file", blob))
 */
export const uploadProfileImageController = async (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({
      status: "error",
      message: 'Missing file. Use multipart/form-data with field "file".',
    });
  }

  const data = await uploadProfileImageBuffer(file.buffer, file.mimetype);
  return sendResponse(res, {
    message: "Image uploaded",
    data: {
      profilePhotoUrl: data.url,
      url: data.url,
      publicId: data.publicId,
      width: data.width,
      height: data.height,
    },
  });
};
