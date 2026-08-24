import type { ReactNode } from "react";
import { AddAssetIntentFooter } from "./AddAssetIntentFooter";
import {
  useTextToImageForm,
  type TextToImageFormParts,
  type UseTextToImageFormOpts,
} from "./useTextToImageForm";

export type { TextToImageFormParts, UseTextToImageFormOpts };

export function TextToImageForm(opts: UseTextToImageFormOpts) {
  const { fields, generateAction, cloneAction } = useTextToImageForm(opts);
  return (
    <>
      {fields}
      <AddAssetIntentFooter
        generate={generateAction ?? undefined}
        clone={cloneAction ?? undefined}
        timeline={{ mode: "hidden" }}
      />
    </>
  );
}

export function TextToImageFormLayout({
  children,
  ...opts
}: UseTextToImageFormOpts & {
  children: (parts: TextToImageFormParts) => ReactNode;
}) {
  const parts = useTextToImageForm(opts);
  return <>{children(parts)}</>;
}
