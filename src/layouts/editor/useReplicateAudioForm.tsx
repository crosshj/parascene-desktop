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
import type { ProjectAsset } from "../../project/types";
import {
  startLibraryParasceneAudio,
  startLibraryParasceneVoiceTrain,
  startLibraryReplicateAudio,
} from "./libraryAssetGenerationStore";
import {
  GEMINI_SYSTEM_VOICES,
  geminiSystemVoiceLabel,
} from "./geminiSystemVoices";
import {
  isMiniMaxSystemVoiceId,
  MINIMAX_SPEECH_EMOTIONS,
  MINIMAX_SYSTEM_VOICES,
} from "./minimaxSystemVoices";
import type { GenerateIntentId, GenerateServerId } from "./previewIntent";
import {
  parasceneAudioModelsForIntent,
  parasceneFieldIsVisible,
  parasceneSpeechPromptMaxChars,
  type ParasceneFieldDef,
} from "./parasceneProductCaps";
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
  server?: Extract<GenerateServerId, "parascene_blue" | "replicate">;
  idPrefix?: string;
  locked?: boolean;
  onGenerateNew?: () => void;
  initialPrompt?: string;
  initialModelId?: string;
  initialExtras?: ReplicateAudioGenerateExtras;
  placeholderId?: string;
  audioAssets?: ProjectAsset[];
};

function extrasToFormValues(
  extras?: ReplicateAudioGenerateExtras,
): Record<string, string> {
  if (!extras) return {};
  const values: Record<string, string> = {};
  const minimaxVoice = extras.voiceId?.trim();
  if (minimaxVoice) {
    if (isMiniMaxSystemVoiceId(minimaxVoice)) {
      values.voice = minimaxVoice;
      values.voice_id = minimaxVoice;
    } else {
      values.voice = "custom";
      values.voice_id = minimaxVoice;
    }
  }
  const geminiVoice = extras.geminiVoice?.trim();
  if (geminiVoice) values.voice = geminiVoice;
  if (extras.stylePrompt) values.style = extras.stylePrompt;
  if (extras.lyrics) values.lyrics = extras.lyrics;
  if (extras.instrumental) values.is_instrumental = "true";
  if (extras.lyricsOptimizer) values.lyrics_optimizer = "true";
  if (extras.emotion) values.emotion = extras.emotion;
  if (extras.cloneSourceAssetId) values.clone_source = extras.cloneSourceAssetId;
  return values;
}

function modelSelectField(
  options: Array<{ id: string; label: string; hint?: string }>,
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

function capsFieldToInput(
  name: string,
  field: ParasceneFieldDef,
): ReplicateInputField {
  const options = (field.options ?? [])
    .map((o) => ({
      id: String(o.value ?? "").trim(),
      label: String(o.label ?? o.value ?? "").trim(),
    }))
    .filter((o) => o.id);
  if (options.length > 0) {
    return stringSelectField(name, field.label || name, options);
  }
  return {
    ...promptSchemaField(name, { description: "" }),
    title: field.label || name,
    description: "",
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
    server = "replicate",
    idPrefix = `audio-${intentId}`,
    locked = false,
    onGenerateNew,
    initialPrompt = "",
    initialModelId,
    initialExtras,
    placeholderId,
    audioAssets = [],
  } = opts;

  const { project } = useShell();
  const aspectRatio = project.aspectRatio ?? DEFAULT_PROJECT_ASPECT_RATIO;
  const isSpeech = intentId === "text_to_speech";
  const isParascene = server === "parascene_blue";
  const parasceneModels = useMemo(
    () => (isParascene ? parasceneAudioModelsForIntent(intentId) : []),
    [isParascene, intentId],
  );

  const [models, setModels] = useState<ReplicateAudioModelOption[] | null>(
    isParascene ? [] : null,
  );
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
    if (isParascene) {
      setModelsError(null);
      setModels([]);
      setModelId((prev) => {
        const preferred = initialModelId?.trim() || prev;
        if (preferred && parasceneModels.some((m) => m.id === preferred)) {
          return preferred;
        }
        const gemini = parasceneModels.find((m) => /gemini/i.test(m.id));
        const lyria = parasceneModels.find((m) => /lyria/i.test(m.id));
        return (intentId === "text_to_speech" ? gemini : lyria)?.id
          ?? parasceneModels[0]?.id
          ?? null;
      });
      return;
    }
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
  }, [intentId, initialModelId, isParascene, parasceneModels]);

  const selectedParascene =
    parasceneModels.find((m) => m.id === modelId) ?? null;
  const selected = isParascene
    ? selectedParascene
    : models?.find((m) => m.id === modelId) ?? null;
  const modelHint = selected?.id ?? modelId ?? initialModelId ?? "";
  const isGemini = /gemini/i.test(modelHint);
  const isMiniMaxSpeech =
    /speech-2\.8|minimax\/speech/i.test(modelHint) && !isGemini;
  const isMusic26 = /music-2\.6|minimax\/music/i.test(modelHint);
  const fieldsLocked = locked || doneLocked;
  const prompt = values.prompt?.trim() ?? "";

  const voiceOptions = useMemo(
    () => [
      ...MINIMAX_SYSTEM_VOICES.map((voice) => ({
        id: voice.voiceId,
        label: voice.label,
      })),
      { id: "custom", label: "Custom" },
    ],
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

  const formModels = isParascene ? parasceneModels : models;
  const speechMaxChars = isSpeech ? parasceneSpeechPromptMaxChars() : undefined;
  const canGenerate =
    !fieldsLocked &&
    Boolean(prompt) &&
    Boolean(selected) &&
    Boolean(project.id) &&
    (speechMaxChars == null || prompt.length <= speechMaxChars);

  const handleGenerateNew = () => {
    setDoneLocked(false);
    onGenerateNew?.();
  };

  const extrasFromValues = (): ReplicateAudioGenerateExtras => {
    const voice = values.voice?.trim();
    const voiceId = values.voice_id?.trim();
    return {
      voiceId: isMiniMaxSpeech
        ? voice === "custom"
          ? voiceId
          : voice || voiceId
        : undefined,
      geminiVoice: isGemini ? voice : undefined,
      stylePrompt: isGemini ? values.style?.trim() : undefined,
      lyrics: isMusic26 ? values.lyrics?.trim() : undefined,
      instrumental: isMusic26 ? values.is_instrumental === "true" : undefined,
      lyricsOptimizer: isMusic26
        ? values.lyrics_optimizer === "true"
        : undefined,
      emotion: isMiniMaxSpeech ? values.emotion?.trim() : undefined,
      cloneSourceAssetId: values.clone_source?.trim(),
    };
  };

  const handleGenerate = () => {
    if (!canGenerate || !project.id || !selected) return;
    setRunning(true);
    const extras = extrasFromValues();
    const id = isParascene
      ? startLibraryParasceneAudio({
          projectId: project.id,
          projectTitle: project.title,
          aspectRatio,
          prompt,
          intentId,
          modelId: selected.id,
          extras,
          placeholderId,
          destination: "assets",
        })
      : startLibraryReplicateAudio({
          projectId: project.id,
          aspectRatio,
          prompt,
          intentId,
          modelId: selected.id,
          extras,
          placeholderId,
          destination: "assets",
        });
    setStartedPlaceholderId(id);
  };

  const handleTrain = () => {
    if (!isParascene || !project.id || fieldsLocked) return;
    const sourceAssetId = values.clone_source?.trim();
    if (!sourceAssetId) return;
    setRunning(true);
    startLibraryParasceneVoiceTrain({
      projectId: project.id,
      projectTitle: project.title,
      aspectRatio,
      sourceAssetId,
      sourceLabel:
        audioAssets.find((a) => a.id === sourceAssetId)?.name || "Voice train",
      onVoiceReady: ({ voiceId }) => {
        setValues((prev) => ({
          ...prev,
          voice: "custom",
          voice_id: voiceId,
        }));
        setRunning(false);
      },
    });
  };

  const onFieldChange = (name: string, value: string) => {
    setValues((prev) => ({ ...prev, [name]: value }));
    if (name === "model") setModelId(value || null);
  };

  const textLabel = isSpeech ? "Line" : "Prompt";
  const textField = {
    ...promptSchemaField("prompt", {
      description: speechMaxChars
        ? `Max ${speechMaxChars} characters`
        : "",
      maxLength: speechMaxChars,
    }),
    title: textLabel,
    description: speechMaxChars ? `Max ${speechMaxChars} characters` : "",
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
      ) : !isParascene && models == null ? (
        <section className="add-asset-generate-section">
          <p className="muted">Loading models…</p>
        </section>
      ) : formModels && formModels.length === 0 ? (
        <section className="add-asset-generate-section">
          <p className="muted">No models available for this intent.</p>
        </section>
      ) : null}
      {formModels && formModels.length > 0 ? (
        <section className="add-asset-generate-section">
          <h3>Model</h3>
          <SchemaScalarField
            field={modelSelectField(formModels)}
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
        {speechMaxChars ? (
          <p className="muted">
            {Math.min(prompt.length, speechMaxChars)}/{speechMaxChars}
          </p>
        ) : null}
      </section>
      {isParascene && selectedParascene
        ? Object.entries(selectedParascene.fields).map(([name, field]) => {
            if (!parasceneFieldIsVisible(field, values)) return null;
            if (field.type === "boolean") {
              return (
                <section className="add-asset-generate-section" key={name}>
                  <label>
                    <input
                      type="checkbox"
                      checked={values[name] === "true"}
                      disabled={fieldsLocked}
                      onChange={(event) =>
                        onFieldChange(
                          name,
                          event.target.checked ? "true" : "",
                        )
                      }
                    />{" "}
                    {field.label || name}
                  </label>
                </section>
              );
            }
            return (
              <section className="add-asset-generate-section" key={name}>
                <h3>{field.label || name}</h3>
                <SchemaScalarField
                  field={capsFieldToInput(name, field)}
                  values={values}
                  onChange={onFieldChange}
                  disabled={fieldsLocked}
                  showFieldChrome={false}
                />
              </section>
            );
          })
        : null}
      {isParascene && isMiniMaxSpeech && values.voice === "custom" ? (
        <section className="add-asset-generate-section">
          <h3>Train</h3>
          <SchemaScalarField
            field={stringSelectField(
              "clone_source",
              "Source audio",
              audioAssets
                .filter((asset) => asset.kind === "audio")
                .map((asset) => ({ id: asset.id, label: asset.name })),
            )}
            values={values}
            onChange={onFieldChange}
            disabled={fieldsLocked}
            showFieldChrome={false}
          />
          <button
            type="button"
            className="btn-secondary"
            disabled={fieldsLocked || !values.clone_source?.trim() || !project.id}
            onClick={handleTrain}
          >
            Train voice
          </button>
        </section>
      ) : null}
      {!isParascene && isMiniMaxSpeech ? (
        <section className="add-asset-generate-section">
          <h3>Voice</h3>
          <SchemaScalarField
            field={stringSelectField("voice", "Voice", voiceOptions)}
            values={values}
            onChange={onFieldChange}
            disabled={fieldsLocked}
            showFieldChrome={false}
          />
        </section>
      ) : null}
      {!isParascene && isMiniMaxSpeech ? (
        <section className="add-asset-generate-section">
          <h3>Emotion</h3>
          <SchemaScalarField
            field={stringSelectField(
              "emotion",
              "Emotion",
              MINIMAX_SPEECH_EMOTIONS.map((emotion) => ({
                id: emotion.value,
                label: emotion.label,
              })),
            )}
            values={values}
            onChange={onFieldChange}
            disabled={fieldsLocked}
            showFieldChrome={false}
          />
        </section>
      ) : null}
      {!isParascene && isMiniMaxSpeech && values.voice === "custom" ? (
        <section className="add-asset-generate-section">
          <h3>Voice ID</h3>
          <SchemaScalarField
            field={promptSchemaField("voice_id", { description: "" })}
            values={values}
            onChange={onFieldChange}
            disabled={fieldsLocked}
            showFieldChrome={false}
          />
        </section>
      ) : null}
      {!isParascene && isGemini ? (
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
      {!isParascene && isGemini ? (
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
      {!isParascene && isMusic26 ? (
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
