import { sendResponse } from "../../utils/sendResponse.js";
import {
  createVehicle,
  deleteVehicle,
  listVehicles,
  updateVehicle,
} from "./vehicle.service.js";

export const createVehicleController = async (req, res) => {
  const vehicle = await createVehicle(req.user, req.body);
  return sendResponse(res, {
    statusCode: 201,
    message: "Vehicle created",
    data: vehicle,
  });
};

export const listVehiclesController = async (req, res) => {
  const vehicles = await listVehicles(req.user, req.query);
  return sendResponse(res, {
    message: "Vehicles fetched",
    data: vehicles,
  });
};

export const updateVehicleController = async (req, res) => {
  const vehicle = await updateVehicle(req.user, req.params.vehicleId, req.body);
  return sendResponse(res, {
    message: "Vehicle updated",
    data: vehicle,
  });
};

export const deleteVehicleController = async (req, res) => {
  const vehicle = await deleteVehicle(req.user, req.params.vehicleId);
  return sendResponse(res, {
    message: "Vehicle deleted",
    data: vehicle,
  });
};
