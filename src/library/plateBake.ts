/** Local plate still bake (side-by-side layout → one JPEG). */

import { invoke } from "@tauri-apps/api/core";

export type PlateBakeInput = {
  imageAssetIds: string[];
  aspectRatio: string;
  /** Longest edge in pixels (default 2048 on the Rust side). */
  resolution?: number;
  placement?: "height_fill" | "equal_columns";
  framing?: "fit" | "fill" | "stretch";
  gapMode?: "auto" | "fixed";
  gapPx?: number;
  marginPx?: number;
  /** Unique preview cache file — do not import. */
  preview?: boolean;
};

export type PlateBakeResult = {
  path: string;
  width: number;
  height: number;
  gapPx: number;
};

export async function bakePlateStill(
  input: PlateBakeInput,
): Promise<PlateBakeResult> {
  return invoke<PlateBakeResult>("library_bake_plate_still", { input });
}
