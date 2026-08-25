/**
 * Unified Text → Image form (Parascene / Blue Direct / Replicate).
 * Collects values → libraryAssetGenerationStore → service_invoke handle.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useShell } from "../../app/ShellProvider";
import { fieldSchemasToInputFields } from "../../forms/fieldSchema";
import { promptSchemaField } from "../../forms/schemaForm";
import { WorkflowForm } from "../../forms/WorkflowForm";
import type { ReplicateInputField } from "../../replicate/replicateClient";
import { DEFAULT_PROJECT_ASPECT_RATIO } from "../../project/aspectRatios";
import { serviceDescribe } from "../../services/serviceClient";
import { serviceIdForGenerateServer } from "../../services/generateServerMap";
import {
  loadBlueStillModels,
  pickBlueStillModel,
} from "./blueStillModels";
import {
  startLibraryBlueDirectTextToImage,
  startLibraryParasceneTextToImage,
  startLibraryReplicateTextToImage,
} from "./libraryAssetGenerationStore";
import {
  parasceneResolveStillModel,
  parasceneStillModelFamilies,
} from "./parasceneProductCaps";
import type { GenerateServerId } from "./previewIntent";
import {
  loadReplicateTextToImageModels,
  type ReplicateTextToImageModelOption,
} from "./replicateTextToImageModels";
import { CloneButton, GenerateTargetButton } from "./AddAssetIntentFooter";

export type TextToImageFormParts = {
  fields: ReactNode;
  generateAction?: ReactNode;
  cloneAction?: ReactNode;
};

export type UseTextToImageFormOpts = {
  server: GenerateServerId;
  idPrefix?: string;
  locked?: boolean;
  onGenerateNew?: () => void;
  initialPrompt?: string;
  initialModelId?: string;
  placeholderId?: string;
};

type ModelOption = {
  id: string;
  label: string;
  hint?: string;
};

function modelSelectField(
  options: ModelOption[],
  label: string,
): ReplicateInputField {
  return {
    name: "model",
    title: label,
    typeName: "string",
    required: true,
    enumValues: options.map((m) => m.id),
    fileLike: false,
    arrayItemFileLike: false,
  };
}

export function useTextToImageForm(
  opts: UseTextToImageFormOpts,
): TextToImageFormParts {
  const {
    server,
    idPrefix = `t2i-${opts.server}`,
    locked = false,
    onGenerateNew,
    initialPrompt = "",
    initialModelId = null,
    placeholderId,
  } = opts;

  const { project } = useShell();
  const aspectRatio = project.aspectRatio ?? DEFAULT_PROJECT_ASPECT_RATIO;

  const parasceneRoutes = useMemo(() => {
    if (server !== "parascene_blue") return null;
    return parasceneStillModelFamilies("text_to_image").flatMap((g) => g.models);
  }, [server]);
  const parasceneModelOptions = useMemo(() => {
    if (!parasceneRoutes) return null;
    return parasceneRoutes.map((m) => ({
      id: m.id,
      label: m.label,
      hint: m.hint,
    }));
  }, [parasceneRoutes]);

  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [replicateModels, setReplicateModels] = useState<
    ReplicateTextToImageModelOption[] | null
  >(null);
  const [modelId, setModelId] = useState<string | null>(initialModelId);
  const [values, setValues] = useState<Record<string, string>>(() => ({
    prompt: initialPrompt,
    ...(initialModelId ? { model: initialModelId } : {}),
  }));
  const [doneLocked, setDoneLocked] = useState(false);
  const [describeFields, setDescribeFields] = useState<ReplicateInputField[]>(
    () => [promptSchemaField(), modelSelectField([], "Model")],
  );

  const fieldsLocked = locked || doneLocked;
  const prompt = values.prompt ?? "";
  const selectedModelId = values.model ?? modelId ?? "";

  useEffect(() => {
    let cancelled = false;
    void serviceDescribe({
      service: serviceIdForGenerateServer(server),
      operation: "generate",
      context: { intent: "text_to_image" },
    })
      .then((describe) => {
        if (cancelled) return;
        const fromDescribe = fieldSchemasToInputFields(describe.fields);
        if (fromDescribe.length > 0) {
          setDescribeFields(fromDescribe);
        }
      })
      .catch(() => {
        /* describe is soft — fall back to local schema */
      });
    return () => {
      cancelled = true;
    };
  }, [server]);

  useEffect(() => {
    let cancelled = false;

    if (server === "parascene_blue") {
      return () => {
        cancelled = true;
      };
    }

    if (server === "replicate") {
      void loadReplicateTextToImageModels()
        .then((rows) => {
          if (cancelled) return;
          setReplicateModels(rows);
          setModels(rows.map((m) => ({ id: m.id, label: m.label })));
          if (fieldsLocked && selectedModelId) return;
          setModelId((prev) => {
            const preferred = prev || initialModelId;
            if (preferred && rows.some((m) => m.id === preferred)) {
              return preferred;
            }
            return rows[0]?.id ?? null;
          });
        })
        .catch((err) => {
          if (cancelled) return;
          setModels([]);
          setModelsError(err instanceof Error ? err.message : String(err));
        });
      return () => {
        cancelled = true;
      };
    }

    if (server === "blue_direct") {
      void loadBlueStillModels("text2image")
        .then((rows) => {
          if (cancelled) return;
          setModelsError(null);
          setModels(rows.map((m) => ({ id: m.id, label: m.label, hint: m.hint })));
          if (!(fieldsLocked && selectedModelId)) {
            const picked =
              pickBlueStillModel(rows, modelId ?? initialModelId)?.id ?? null;
            setModelId(picked);
          }
        })
        .catch((err) => {
          if (cancelled) return;
          setModels([]);
          setModelsError(err instanceof Error ? err.message : String(err));
        });
      return () => {
        cancelled = true;
      };
    }

    return () => {
      cancelled = true;
    };
  }, [server, fieldsLocked, selectedModelId, initialModelId, modelId]);

  const formModels = parasceneModelOptions ?? models;
  if (formModels?.length && !(fieldsLocked && selectedModelId)) {
    const preferred = modelId || initialModelId;
    const nextModelId =
      preferred && formModels.some((m) => m.id === preferred)
        ? preferred
        : formModels[0]?.id ?? null;
    if (nextModelId && nextModelId !== modelId) {
      setModelId(nextModelId);
    }
  }
  if (formModels?.length) {
    const nextModel =
      values.model && formModels.some((m) => m.id === values.model)
        ? values.model
        : modelId && formModels.some((m) => m.id === modelId)
          ? modelId
          : formModels[0]?.id ?? "";
    if (nextModel && nextModel !== values.model) {
      setValues((prev) => ({ ...prev, model: nextModel }));
    }
  }

  const schemaFields = useMemo(() => {
    const modelField = describeFields.find((f) => f.name === "model");
    const promptField =
      describeFields.find((f) => f.name === "prompt") ?? promptSchemaField();
    const modelOptions = formModels ?? [];
    const mergedModel: ReplicateInputField = modelField
      ? {
          ...modelField,
          enumValues:
            modelOptions.length > 0
              ? modelOptions.map((m) => m.id)
              : modelField.enumValues,
        }
      : modelSelectField(
          modelOptions,
          server === "blue_direct" ? "Blue model" : "Model",
        );
    return [mergedModel, promptField];
  }, [describeFields, formModels, server]);

  const lockedReviewKey = locked
    ? `${initialPrompt}\0${initialModelId ?? ""}`
    : "";
  const [appliedLockedReviewKey, setAppliedLockedReviewKey] =
    useState(lockedReviewKey);
  if (locked && lockedReviewKey !== appliedLockedReviewKey) {
    setAppliedLockedReviewKey(lockedReviewKey);
    setValues({
      prompt: initialPrompt,
      ...(initialModelId ? { model: initialModelId } : {}),
    });
    if (initialModelId) setModelId(initialModelId);
  }

  const canGenerate =
    !fieldsLocked &&
    Boolean(prompt.trim()) &&
    Boolean(selectedModelId.trim()) &&
    Boolean(project.id) &&
    Boolean(formModels?.length);

  const handleGenerateNew = () => {
    setDoneLocked(false);
    onGenerateNew?.();
  };

  const handleGenerate = () => {
    if (!canGenerate || !project.id) return;
    const modelKey = selectedModelId.trim();
    if (!modelKey) return;

    if (server === "parascene_blue") {
      const route =
        parasceneRoutes?.find((m) => m.id === modelKey) ??
        parasceneResolveStillModel("text_to_image", modelKey);
      if (!route) return;
      startLibraryParasceneTextToImage({
        projectId: project.id,
        projectTitle: project.title,
        imagesGroupId: project.imagesGroupId,
        videosGroupId: project.videosGroupId,
        aspectRatio,
        prompt,
        modelId: route.id,
        route,
        placeholderId,
        destination: "assets",
      });
      return;
    }

    if (server === "replicate") {
      const model =
        replicateModels?.find((m) => m.id === modelKey) ?? null;
      if (!model) return;
      startLibraryReplicateTextToImage({
        projectId: project.id,
        aspectRatio,
        prompt,
        model,
        placeholderId,
        destination: "assets",
      });
      return;
    }

    startLibraryBlueDirectTextToImage({
      projectId: project.id,
      aspectRatio,
      prompt,
      modelId: modelKey,
      placeholderId,
      destination: "assets",
    });
  };

  const modelLabel =
    server === "blue_direct"
      ? "Blue model"
      : server === "parascene_blue"
        ? "Parascene model"
        : "Model";

  const fields = (
    <WorkflowForm
      className={`add-asset-workflow-form ${idPrefix}-form`}
      fields={schemaFields}
      values={values}
      onChange={(name, value) => {
        setValues((prev) => ({ ...prev, [name]: value }));
        if (name === "model") setModelId(value || null);
      }}
      disabled={fieldsLocked}
      onSubmit={() => handleGenerate()}
      beforeFields={
        modelsError ? (
          <section className="add-asset-generate-section">
            <p className="add-asset-generate-error">{modelsError}</p>
          </section>
        ) : formModels == null ? (
          <section className="add-asset-generate-section">
            <p className="muted">Loading {modelLabel.toLowerCase()}…</p>
          </section>
        ) : formModels.length === 0 ? (
          <section className="add-asset-generate-section">
            <p className="muted">No models available for this server.</p>
          </section>
        ) : null
      }
    />
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
        disabled={!canGenerate}
        running={false}
        onClick={() => handleGenerate()}
      />
    ) : null;

  return { fields, generateAction, cloneAction };
}
