/**
 * Shared text → image input builders for Generate → Assets.
 */
import type { ProjectAspectRatio } from "../../project/aspectRatios";
import {
  aspectChooserOptionsFromSupported,
  pickAspectChooserValue,
} from "../../project/aspectRatios";
import type { ReplicateTextToImageModelOption } from "./replicateTextToImageModels";

export function buildReplicateTextToImageInput(opts: {
  model: ReplicateTextToImageModelOption;
  prompt: string;
  aspectRatio: ProjectAspectRatio;
}): Record<string, unknown> {
  const prompt = opts.prompt.trim();
  const input: Record<string, unknown> = {
    [opts.model.promptField]: prompt,
  };
  if (opts.model.aspectRatioField) {
    const field = opts.model.inputs.find(
      (row) => row.name === opts.model.aspectRatioField,
    );
    const options = aspectChooserOptionsFromSupported(field?.enumValues);
    if (options.length > 0) {
      input[opts.model.aspectRatioField] = pickAspectChooserValue(
        options,
        opts.aspectRatio,
      );
    } else {
      input[opts.model.aspectRatioField] = opts.aspectRatio;
    }
  }
  return input;
}
