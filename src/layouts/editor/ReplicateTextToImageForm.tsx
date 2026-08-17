/**
 * Inline prompt + model form for Replicate text → image into Assets.
 */

import type { ReactNode } from "react";
import {
  useReplicateTextToImageForm,
  type ReplicateTextToImageFormParts,
  type UseReplicateTextToImageFormOpts,
} from "./useReplicateTextToImageForm";

export type { ReplicateTextToImageFormParts };

/**
 * Host that keeps sticky footer layout: renders children(fields) in the scroll
 * body and footer as a pane sibling.
 */
export function ReplicateTextToImageFormLayout({
  idPrefix = "replicate-t2i",
  locked,
  hideInlineProgress,
  onGenerateStateChange,
  onGenerateNew,
  initialPrompt,
  initialModelId,
  children,
}: UseReplicateTextToImageFormOpts & {
  children: (parts: ReplicateTextToImageFormParts) => ReactNode;
}) {
  const parts = useReplicateTextToImageForm({
    idPrefix,
    locked,
    hideInlineProgress,
    onGenerateStateChange,
    onGenerateNew,
    initialPrompt,
    initialModelId,
  });
  return <>{children(parts)}</>;
}

/** Fields + footer for hosts that keep both inside the scroll body. */
export function ReplicateTextToImageForm({
  idPrefix = "replicate-t2i",
  locked,
  hideInlineProgress,
  onGenerateStateChange,
  onGenerateNew,
  initialPrompt,
  initialModelId,
}: UseReplicateTextToImageFormOpts) {
  const { fields, footer } = useReplicateTextToImageForm({
    idPrefix,
    locked,
    hideInlineProgress,
    onGenerateStateChange,
    onGenerateNew,
    initialPrompt,
    initialModelId,
  });
  return (
    <>
      {fields}
      {footer}
    </>
  );
}
