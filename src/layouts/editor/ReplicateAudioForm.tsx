import type { ReactNode } from "react";
import {
  useReplicateAudioForm,
  type ReplicateAudioFormParts,
  type UseReplicateAudioFormOpts,
} from "./useReplicateAudioForm";

export type { ReplicateAudioFormParts, UseReplicateAudioFormOpts };

export function ReplicateAudioFormLayout({
  children,
  ...opts
}: UseReplicateAudioFormOpts & {
  children: (parts: ReplicateAudioFormParts) => ReactNode;
}) {
  const parts = useReplicateAudioForm(opts);
  return <>{children(parts)}</>;
}
