import type { ReactNode } from "react";
import { AddAssetIntentFooter } from "./AddAssetIntentFooter";
import {
  useParasceneImageToImageForm,
  type ParasceneImageToImageFormParts,
  type UseParasceneImageToImageFormOpts,
} from "./useParasceneImageToImageForm";

export function ParasceneImageToImageForm(
  opts: UseParasceneImageToImageFormOpts = {},
) {
  const { fields, generateAction, cloneAction } =
    useParasceneImageToImageForm(opts);
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

export function ParasceneImageToImageFormLayout({
  children,
  ...opts
}: UseParasceneImageToImageFormOpts & {
  children: (parts: ParasceneImageToImageFormParts) => ReactNode;
}) {
  const parts = useParasceneImageToImageForm(opts);
  return <>{children(parts)}</>;
}
