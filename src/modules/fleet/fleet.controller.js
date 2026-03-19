import { sendResponse } from "../../utils/sendResponse.js";
import { getFleetDashboard } from "./fleet.service.js";

export const fleetDashboardController = async (req, res) => {
  const result = await getFleetDashboard(req.user, req.query);
  return sendResponse(res, {
    message: "Fleet dashboard fetched",
    data: result,
  });
};
