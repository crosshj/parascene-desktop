export const OPEN_NEW_ASSET_EVENT = "parascene-open-new-asset";

export type OpenNewAssetDetail = {
  intent?: "text_to_image" | "text_to_speech" | "text_to_music";
  prompt?: string;
  model?: string;
  voice?: string;
  emotion?: string;
  style?: string;
};

export function requestOpenNewAsset(detail: OpenNewAssetDetail = {}) {
  window.dispatchEvent(new CustomEvent(OPEN_NEW_ASSET_EVENT, { detail }));
}
