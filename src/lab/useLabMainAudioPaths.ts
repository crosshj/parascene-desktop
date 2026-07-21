import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCreations } from "../library/catalogClient";
import { cachedFullVocalsPath } from "./audioTools";

export type LabMainAudioPaths = {
  mixPath: string | null;
  mixUrl: string | null;
  vocalsPath: string | null;
  vocalsUrl: string | null;
  vocalsReady: boolean;
};

export function useLabMainAudioPaths(mainAudioId: string): LabMainAudioPaths {
  const [mixPath, setMixPath] = useState<string | null>(null);
  const [mixUrl, setMixUrl] = useState<string | null>(null);
  const [vocalsPath, setVocalsPath] = useState<string | null>(null);
  const [vocalsUrl, setVocalsUrl] = useState<string | null>(null);
  const [vocalsReady, setVocalsReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!mainAudioId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMixPath(null);
      setMixUrl(null);
      setVocalsPath(null);
      setVocalsUrl(null);
      setVocalsReady(false);
      return;
    }
    void getCreations([mainAudioId]).then(async (rows) => {
      if (cancelled) return;
      const path = rows[0]?.localPath?.trim() || null;
      setMixPath(path);
      setMixUrl(path ? convertFileSrc(path) : null);
      setVocalsPath(null);
      setVocalsUrl(null);
      setVocalsReady(false);
      if (path) {
        try {
          const cached = await cachedFullVocalsPath(path);
          if (!cancelled && cached) {
            setVocalsPath(cached);
            setVocalsUrl(convertFileSrc(cached, "media"));
            setVocalsReady(true);
          }
        } catch {
          /* no cached stem */
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [mainAudioId]);

  return { mixPath, mixUrl, vocalsPath, vocalsUrl, vocalsReady };
}
