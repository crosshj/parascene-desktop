/** Capability stubs — interfaces until real features land. */

import { listCreations } from "../library/catalogClient";
import type { Creation } from "../library/types";
import { syncCreationsManifest } from "../sync/manifestSync";

export type CapabilityResult =
  | { status: "ok" }
  | { status: "unimplemented"; message?: string };

export interface CreationSync {
  sync(): Promise<CapabilityResult>;
}

export interface AssetLibrary {
  list(): Promise<Creation[]>;
}

export interface TimelineCommands {
  apply(command: string): Promise<CapabilityResult>;
}

export interface LlmAssistant {
  ask(prompt: string): Promise<CapabilityResult>;
}

export interface Rendering {
  render(): Promise<CapabilityResult>;
}

export interface HookPublishing {
  publish(): Promise<CapabilityResult>;
}

export const unimplemented = (
  feature: string,
): Promise<CapabilityResult> =>
  Promise.resolve({
    status: "unimplemented",
    message: `${feature} is not implemented in the desktop shell`,
  });

export const creationSyncStub: CreationSync = {
  sync: async () => {
    await syncCreationsManifest();
    return { status: "ok" };
  },
};

export const assetLibraryStub: AssetLibrary = {
  list: () => listCreations(),
};

export const timelineCommandsStub: TimelineCommands = {
  apply: () => unimplemented("timeline commands"),
};

export const llmAssistantStub: LlmAssistant = {
  ask: () => unimplemented("LLM assistant"),
};

export const renderingStub: Rendering = {
  render: () => unimplemented("rendering"),
};

export const hookPublishingStub: HookPublishing = {
  publish: () => unimplemented("hook publishing"),
};
