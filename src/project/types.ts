export type LayoutMode = "director" | "editor" | "hook";

export type Scene = {
  id: string;
  title: string;
  durationLabel: string;
};

export type ProjectAsset = {
  id: string;
  name: string;
  kind: "video" | "audio" | "image";
};

export type TimelineClip = {
  id: string;
  label: string;
  startSec: number;
  endSec: number;
};

export type HookSuggestion = {
  id: string;
  text: string;
};

export type Project = {
  id: string;
  title: string;
  scenes: Scene[];
  assets: ProjectAsset[];
  timeline: TimelineClip[];
  hookSuggestions: HookSuggestion[];
};

export interface ProjectRepository {
  getProject(): Project;
}
