/**
 * Inline prompt + model form for Replicate text → image into Assets.
 */

import type { ReactNode } from "react";
import {
  useReplicateTextToImageForm,
  type ReplicateTextToImageFormParts,
} from "./useReplicateTextToImageForm";

export type { ReplicateTextToImageFormParts };

/**
 * Host that keeps sticky footer layout: renders children(fields) in the scroll
 * body and footer as a pane sibling.
 */
export function ReplicateTextToImageFormLayout({
  idPrefix = "replicate-t2i",
  children,
}: {
  idPrefix?: string;
  children: (parts: ReplicateTextToImageFormParts) => ReactNode;
}) {
  const parts = useReplicateTextToImageForm(idPrefix);
  return <>{children(parts)}</>;
}

/** Fields + footer for hosts that keep both inside the scroll body. */
export function ReplicateTextToImageForm({
  idPrefix = "replicate-t2i",
}: {
  idPrefix?: string;
}) {
  const { fields, footer } = useReplicateTextToImageForm(idPrefix);
  return (
    <>
      {fields}
      {footer}
    </>
  );
}
