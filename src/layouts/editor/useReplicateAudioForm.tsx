/**
 * Replicate Text → Speech / Text → Music form (Generate → Assets).
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useShell } from "../../app/ShellProvider";
import { promptSchemaField } from "../../forms/schemaForm";
import { SchemaScalarField } from "../../forms/SchemaScalarField";
import { DEFAULT_PROJECT_ASPECT_RATIO } from "../../project/aspectRatios";
import type { ReplicateInputField } from "../../replicate/replicateClient";
import { CloneButton, GenerateTargetButton } from "./AddAssetIntentFooter";
import type { ReplicateAudioGenerateExtras } from "./audioGenerateInputs";
import { startLibraryReplicateAudio } from "./libraryAssetGenerationStore";
import {
  GEMINI_SYSTEM_VOICES,
  geminiSystemVoiceLabel,
} from "./geminiSystemVoices";
import {
  isMiniMaxSystemVoiceId,
  MINIMAX_SYSTEM_VOICES,
} from "./minimaxSystemVoices";
import type { GenerateIntentId } from "./previewIntent";
import {
  loadCuratedReplicateAudioModels,
  pickCuratedAudioModelId,
  type ReplicateAudioModelOption,
} from "./replicateAudioModels";

export type ReplicateAudioFormParts = {
  fields: ReactNode;
  generateAction?: ReactNode;
  cloneAction?: ReactNode;
};

export type UseReplicateAudioFormOpts = {
  intentId: Extract<GenerateIntentId, "text_to_speech" | "text_to_music">;
  idPrefix?: string;
  locked?: boolean;
  onGenerateNew?: () => void;
  initialPrompt?: string;
  initialModelId?: string;
  initialExtras?: ReplicateAudioGenerateExtras;
  placeholderId?: string;
};

function extrasToFormValues(
  extras?: ReplicateAudioGenerateExtras,
): Record<string, string> {
  if (!extras) return {};
  const values: Record<string, string> = {};
  const minimaxVoice = extras.voiceId?.trim();
  if (minimaxVoice && isMiniMaxSystemVoiceId(minimaxVoice)) {
    values.voice_id = minimaxVoice;
  }
  const geminiVoice = extras.geminiVoice?.trim();
  if (geminiVoice) values.voice = geminiVoice;
  if (extras.stylePrompt) values.style = extras.stylePrompt;
  if (extras.lyrics) values.lyrics = extras.lyrics;
  if (extras.instrumental) values.is_instrumental = "true";
  if (extras.lyricsOptimizer) values.lyrics_optimizer = "true";
  if (extras.emotion) values.emotion = extras.emotion;
  return values;
}

function modelSelectField(
  options: ReplicateAudioModelOption[],
): ReplicateInputField {
  return {
    name: "model",
    title: "Model",
    typeName: "string",
    required: true,
    enumValues: options.map((m) => m.id),
    enumLabels: Object.fromEntries(
      options.map((m) => [m.id, m.hint ? `${m.label} — ${m.hint}` : m.label]),
    ),
    enumGroups: null,
    fileLike: false,
    arrayItemFileLike: false,
  };
}

function stringSelectField(
  name: string,
  title: string,
  options: Array<{ id: string; label: string }>,
): ReplicateInputField {
  return {
    name,
    title,
    typeName: "string",
    required: false,
    enumValues: options.map((o) => o.id),
    enumLabels: Object.fromEntries(options.map((o) => [o.id, o.label])),
    enumGroups: null,
    fileLike: false,
    arrayItemFileLike: false,
  };
}

export function useReplicateAudioForm(
  opts: UseReplicateAudioFormOpts,
): ReplicateAudioFormParts {
  const {
    intentId,
    idPrefix = `audio-${intentId}`,
    locked = false,
    onGenerateNew,
    initialPrompt = "",
    initialModelId,
    initialExtras,
    placeholderId,
  } = opts;

  const { project } = useShell();
  const aspectRatio = project.aspectRatio ?? DEFAULT_PROJECT_ASPECT_RATIO;
  const isSpeech = intentId === "text_to_speech";

  const [models, setModels] = useState<ReplicateAudioModelOption[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string | null>(
    initialModelId?.trim() || null,
  );
  const [values, setValues] = useState<Record<string, string>>({
    prompt: initialPrompt,
    ...extrasToFormValues(initialExtras),
  });
  const [running, setRunning] = useState(false);
  const [startedPlaceholderId, setStartedPlaceholderId] = useState<string | null>(
    null,
  );
  const [doneLocked, setDoneLocked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setModels(null);
    setModelsError(null);
    void loadCuratedReplicateAudioModels(intentId)
      .then((rows) => {
        if (cancelled) return;
        setModels(rows);
        setModelId((prev) => pickCuratedAudioModelId(rows, prev, initialModelId));
      })
      .catch((err) => {
        if (cancelled) return;
        setModelsError(err instanceof Error ? err.message : String(err));
        setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [intentId, initialModelId]);

  const selected = models?.find((m) => m.id === modelId) ?? null;
  const modelHint = selected?.id ?? modelId ?? initialModelId ?? "";
  const isGemini = /gemini/i.test(modelHint);
  const isMiniMaxSpeech =
    /speech-2\.8|minimax\/speech/i.test(modelHint) && !isGemini;
  const isMusic26 = /music-2\.6|minimax\/music/i.test(modelHint);
  const fieldsLocked = locked || doneLocked;
  const prompt = values.prompt?.trim() ?? "";

  const voiceOptions = useMemo(
    () =>
      MINIMAX_SYSTEM_VOICES.map((voice) => ({
        id: voice.voiceId,
        label: voice.label,
      })),
    [],
  );

  const geminiVoiceField = selected?.inputs.find((f) => f.name === "voice");
  const geminiVoices = useMemo(() => {
    const ids = geminiVoiceField?.enumValues?.filter(Boolean) ?? [];
    const source = ids.length > 0 ? ids : GEMINI_SYSTEM_VOICES.map((v) => v.voiceId);
    return source.map((id) => ({
      id,
      label: geminiSystemVoiceLabel(id),
    }));
  }, [geminiVoiceField?.enumValues]);

  const formSeedKey = `${initialPrompt}\0${initialModelId ?? ""}\0${JSON.stringify(initialExtras ?? {})}`;
  const [appliedFormSeedKey, setAppliedFormSeedKey] = useState(formSeedKey);
  if (formSeedKey !== appliedFormSeedKey) {
    setAppliedFormSeedKey(formSeedKey);
    setValues({ prompt: initialPrompt, ...extrasToFormValues(initialExtras) });
    if (initialModelId?.trim()) setModelId(initialModelId.trim());
  }

  const trackedPlaceholderId =
    placeholderId?.trim() || startedPlaceholderId?.trim() || "";
  const placeholderStatus = trackedPlaceholderId
    ? project.libraryAssetPlaceholders?.[trackedPlaceholderId]?.status
    : undefined;
  const generateRunning =
    running || placeholderStatus === "generating";

  useEffect(() => {
    if (!trackedPlaceholderId) return;
    if (placeholderStatus && placeholderStatus !== "generating") {
      setRunning(false);
    }
    if (!placeholderStatus && startedPlaceholderId) {
      setRunning(false);
    }
  }, [placeholderStatus, startedPlaceholderId, trackedPlaceholderId]);

  const canGenerate =
    !fieldsLocked &&
    Boolean(prompt) &&
    Boolean(selected) &&
    Boolean(project.id);

  const handleGenerateNew = () => {
    setDoneLocked(false);
    onGenerateNew?.();
  };

  const handleGenerate = () => {
    if (!canGenerate || !project.id || !selected) return;
    setRunning(true);
    const minimaxVoice = values.voice_id?.trim();
    const id = startLibraryReplicateAudio({
      projectId: project.id,
      aspectRatio,
      prompt,
      intentId,
      modelId: selected.id,
      extras: {
        voiceId:
          isMiniMaxSpeech && minimaxVoice && isMiniMaxSystemVoiceId(minimaxVoice)
            ? minimaxVoice
            : undefined,
        geminiVoice: isGemini ? values.voice?.trim() : undefined,
        stylePrompt: isGemini ? values.style?.trim() : undefined,
        lyrics: isMusic26 ? values.lyrics?.trim() : undefined,
        instrumental: isMusic26 ? values.is_instrumental === "true" : undefined,
        lyricsOptimizer: isMusic26
          ? values.lyrics_optimizer === "true"
          : undefined,
        emotion: isMiniMaxSpeech ? values.emotion?.trim() : undefined,
      },
      placeholderId,
      destination: "assets",
    });
    setStartedPlaceholderId(id);
  };

  const onFieldChange = (name: string, value: string) => {
    setValues((prev) => ({ ...prev, [name]: value }));
    if (name === "model") setModelId(value || null);
  };

  const textLabel = isSpeech ? "Line" : "Prompt";
  const textField = {
    ...promptSchemaField("prompt", { description: "" }),
    title: textLabel,
    description: "",
  };

  const fields = (
    <form
      className={`add-asset-workflow-form ${idPrefix}-form`}
      onSubmit={(event) => {
        event.preventDefault();
        if (fieldsLocked) return;
        handleGenerate();
      }}
    >
      {modelsError ? (
        <section className="add-asset-generate-section">
          <p className="add-asset-generate-error">{modelsError}</p>
        </section>
      ) : models == null ? (
        <section className="add-asset-generate-section">
          <p className="muted">Loading models…</p>
        </section>
      ) : models.length === 0 ? (
        <section className="add-asset-generate-section">
          <p className="muted">No models available for this intent.</p>
        </section>
      ) : null}
      {models && models.length > 0 ? (
        <section className="add-asset-generate-section">
          <h3>Model</h3>
          <SchemaScalarField
            field={modelSelectField(models)}
            values={{ ...values, model: modelId ?? "" }}
            onChange={onFieldChange}
            disabled={fieldsLocked}
            showFieldChrome={false}
          />
        </section>
      ) : null}
      <section className="add-asset-generate-section">
        <h3>{textLabel}</h3>
        <SchemaScalarField
          field={textField}
          values={values}
          onChange={onFieldChange}
          disabled={fieldsLocked}
          showFieldChrome={false}
        />
      </section>
      {isMiniMaxSpeech ? (
        <section className="add-asset-generate-section">
          <h3>Voice</h3>
          <SchemaScalarField
            field={stringSelectField("voice_id", "Voice", voiceOptions)}
            values={values}
            onChange={onFieldChange}
            disabled={fieldsLocked}
            showFieldChrome={false}
          />
        </section>
      ) : null}
      {isGemini ? (
        <section className="add-asset-generate-section">
          <h3>Voice</h3>
          <SchemaScalarField
            field={
              geminiVoices.length > 0
                ? stringSelectField("voice", "Voice", geminiVoices)
                : {
                    ...promptSchemaField("voice", { description: "" }),
                    title: "Voice",
                    description: "",
                  }
            }
            values={values}
            onChange={onFieldChange}
            disabled={fieldsLocked}
            showFieldChrome={false}
          />
        </section>
      ) : null}
      {isGemini ? (
        <section className="add-asset-generate-section">
          <h3>Style</h3>
          <SchemaScalarField
            field={promptSchemaField("style", { description: "" })}
            values={values}
            onChange={onFieldChange}
            disabled={fieldsLocked}
            showFieldChrome={false}
          />
        </section>
      ) : null}
      {isMusic26 ? (
        <>
          <section className="add-asset-generate-section">
            <h3>Lyrics</h3>
            <SchemaScalarField
              field={promptSchemaField("lyrics", { description: "" })}
              values={values}
              onChange={onFieldChange}
              disabled={fieldsLocked}
              showFieldChrome={false}
            />
          </section>
          <section className="add-asset-generate-section">
            <label>
              <input
                type="checkbox"
                checked={values.is_instrumental === "true"}
                disabled={fieldsLocked}
                onChange={(event) =>
                  onFieldChange(
                    "is_instrumental",
                    event.target.checked ? "true" : "",
                  )
                }
              />{" "}
              Instrumental
            </label>
            <label>
              <input
                type="checkbox"
                checked={values.lyrics_optimizer === "true"}
                disabled={fieldsLocked}
                onChange={(event) =>
                  onFieldChange(
                    "lyrics_optimizer",
                    event.target.checked ? "true" : "",
                  )
                }
              />{" "}
              Lyrics optimizer
            </label>
          </section>
        </>
      ) : null}
    </form>
  );

  const cloneAction =
    onGenerateNew && (doneLocked || locked) ? (
      <CloneButton
        onClick={doneLocked ? handleGenerateNew : () => onGenerateNew?.()}
      />
    ) : null;

  const generateAction =
    !doneLocked && !(locked && onGenerateNew) ? (
      <GenerateTargetButton
        target="Assets"
        disabled={!canGenerate || generateRunning}
        running={generateRunning}
        onClick={() => handleGenerate()}
      />
    ) : null;

  return { fields, generateAction, cloneAction };
}
