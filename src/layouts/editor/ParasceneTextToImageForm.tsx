import type { ReactNode } from "react";
import { AddAssetIntentFooter } from "./AddAssetIntentFooter";
import {
  useParasceneTextToImageForm,
  type ParasceneTextToImageFormParts,
  type UseParasceneTextToImageFormOpts,
} from "./useParasceneTextToImageForm";

export function ParasceneTextToImageForm(
  opts: UseParasceneTextToImageFormOpts = {},
) {
  const { fields, generateAction, cloneAction } =
    useParasceneTextToImageForm(opts);
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

export function ParasceneTextToImageFormLayout({
  children,
  ...opts
}: UseParasceneTextToImageFormOpts & {
  children: (parts: ParasceneTextToImageFormParts) => ReactNode;
}) {
  const parts = useParasceneTextToImageForm(opts);
  return <>{children(parts)}</>;
}
