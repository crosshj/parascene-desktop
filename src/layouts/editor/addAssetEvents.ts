export const OPEN_NEW_ASSET_EVENT = "parascene-open-new-asset";

export type OpenNewAssetDetail = {
  intent?: "text_to_image";
  prompt?: string;
  model?: string;
};

export function requestOpenNewAsset(detail: OpenNewAssetDetail = {}) {
  window.dispatchEvent(new CustomEvent(OPEN_NEW_ASSET_EVENT, { detail }));
}
