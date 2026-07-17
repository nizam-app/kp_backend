import { ISSUE_TYPES } from "../../constants/domain.js";

export const DEFAULT_JOB_CATEGORIES = Object.freeze([
  {
    key: "FLAT_DAMAGED_TYRE",
    label: "Flat / Damaged Tyre",
    issueType: ISSUE_TYPES.FLAT_DAMAGED_TYRE,
    icon: "🛞",
    sortOrder: 10,
  },
  {
    key: "BATTERY_FAILURE_JUMP_START",
    label: "Battery Failure / Jump Start",
    issueType: ISSUE_TYPES.BATTERY_FAILURE_JUMP_START,
    icon: "🔋",
    sortOrder: 20,
  },
  {
    key: "ENGINE_WONT_START",
    label: "Engine Won't Start",
    issueType: ISSUE_TYPES.ENGINE_WONT_START,
    icon: "🔑",
    sortOrder: 30,
  },
  {
    key: "BRAKE_ISSUES_WARNING_LIGHT",
    label: "Brake Issues / Warning Light",
    issueType: ISSUE_TYPES.BRAKE_PROBLEM,
    icon: "🛑",
    sortOrder: 40,
  },
  {
    key: "ELECTRICAL_PROBLEM",
    label: "Electrical Problem",
    issueType: ISSUE_TYPES.ELECTRICAL_ISSUE,
    icon: "⚡",
    sortOrder: 50,
  },
  {
    key: "OVERHEATING_COOLANT_LEAK",
    label: "Overheating / Coolant Leak",
    issueType: ISSUE_TYPES.OVERHEATING,
    icon: "🌡️",
    sortOrder: 60,
  },
  {
    key: "AIR_PNEUMATIC_SYSTEM",
    label: "Air / Pneumatic System",
    issueType: ISSUE_TYPES.AIR_PNEUMATIC_SYSTEM,
    icon: "💨",
    sortOrder: 70,
  },
  {
    key: "TRANSMISSION_GEARBOX",
    label: "Transmission / Gearbox",
    issueType: ISSUE_TYPES.TRANSMISSION_GEARBOX,
    icon: "🔧",
    sortOrder: 80,
  },
  {
    key: "OIL_FLUID_LEAK",
    label: "Oil / Fluid Leak",
    issueType: ISSUE_TYPES.OIL_FLUID_LEAK,
    icon: "🛢️",
    sortOrder: 90,
  },
  {
    key: "LIGHTS_NOT_WORKING",
    label: "Lights Not Working",
    issueType: ISSUE_TYPES.LIGHTS_NOT_WORKING,
    icon: "💡",
    sortOrder: 100,
  },
  {
    key: "TRAILER_COUPLING_ISSUE",
    label: "Trailer / Coupling Issue",
    issueType: ISSUE_TYPES.TRAILER_COUPLING_ISSUE,
    icon: "🚛",
    sortOrder: 110,
  },
  {
    key: "OTHER_NOT_SURE",
    label: "Other / Not Sure",
    issueType: ISSUE_TYPES.OTHER_DESCRIBE_IN_NOTES,
    icon: "❓",
    sortOrder: 120,
    aliases: ["OTHER_DESCRIBE_IN_NOTES"],
  },
]);

export const DEFAULT_JOB_CATEGORY_BY_KEY = Object.freeze(
  Object.fromEntries(DEFAULT_JOB_CATEGORIES.map((category) => [category.key, category]))
);
