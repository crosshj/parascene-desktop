/**
 * @deprecated Prefer `src/services/cloudRepair.ts` (service_invoke).
 * Kept for tests / transitional imports; production Library uses the service façade.
 */
export {
  runCloudRepair as runCloudLibraryRepair,
  type CloudRepairResult as CloudRepairSummary,
} from "../services/cloudRepair";
