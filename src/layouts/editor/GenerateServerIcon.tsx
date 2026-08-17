/** Brand marks for Generate server cards. */

import type { GenerateServerId } from "./previewIntent";
import { ParasceneMark } from "../../ui/ParasceneMark";
import { ReplicateMark } from "../../ui/ReplicateMark";

export function GenerateServerIcon({
  serverId,
}: {
  serverId: GenerateServerId;
}) {
  switch (serverId) {
    case "parascene_blue":
      return <ParasceneMark />;
    case "blue_direct":
      return <ParasceneMark tone="blue" />;
    case "replicate":
      return <ReplicateMark />;
    default:
      return null;
  }
}
