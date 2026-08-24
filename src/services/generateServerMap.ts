/**
 * Map Generate server lanes → service kernel ids.
 */
import type { GenerateServerId } from "../layouts/editor/previewIntent";
import type { ServiceId } from "./types";

export function serviceIdForGenerateServer(
  server: GenerateServerId,
): ServiceId {
  switch (server) {
    case "parascene_blue":
      return "parascene";
    case "blue_direct":
      return "blue";
    case "replicate":
      return "replicate";
    default:
      return "parascene";
  }
}
