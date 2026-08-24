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
import type { CreationTarget } from "../../services/types";
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
  type ParasceneStillModelOption,
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
  /** Show Generate → Timeline when the intent allows it. */
  allowTimelineTarget?: boolean;
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
    allowTimelineTarget = false,
  } = opts;

  const { project } = useShell();
  const aspectRatio = project.aspectRatio ?? DEFAULT_PROJECT_ASPECT_RATIO;

  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [parasceneRoutes, setParasceneRoutes] = useState<
    ParasceneStillModelOption[] | null
  >(null);
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
      const families = parasceneStillModelFamilies("text_to_image");
      const routes = families.flatMap((g) => g.models);
      setParasceneRoutes(routes);
      setModels(
        routes.map((m) => ({ id: m.id, label: m.label, hint: m.hint })),
      );
      if (!(fieldsLocked && selectedModelId)) {
        setModelId((prev) => {
          const preferred = prev || initialModelId;
          if (preferred && routes.some((m) => m.id === preferred)) {
            return preferred;
          }
          return routes[0]?.id ?? null;
        });
      }
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

  useEffect(() => {
    if (!models?.length) return;
    setValues((prev) => {
      const nextModel =
        prev.model && models.some((m) => m.id === prev.model)
          ? prev.model
          : modelId && models.some((m) => m.id === modelId)
            ? modelId
            : models[0]?.id ?? "";
      return nextModel ? { ...prev, model: nextModel } : prev;
    });
  }, [models, modelId]);

  const schemaFields = useMemo(() => {
    const modelField = describeFields.find((f) => f.name === "model");
    const promptField =
      describeFields.find((f) => f.name === "prompt") ?? promptSchemaField();
    const modelOptions = models ?? [];
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
  }, [describeFields, models, server]);

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
    Boolean(models?.length);

  const handleGenerateNew = () => {
    setDoneLocked(false);
    onGenerateNew?.();
  };

  const handleGenerate = (target: CreationTarget) => {
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
        destination: target,
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
        destination: target,
      });
      return;
    }

    startLibraryBlueDirectTextToImage({
      projectId: project.id,
      aspectRatio,
      prompt,
      modelId: modelKey,
      placeholderId,
      destination: target,
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
      onSubmit={() => handleGenerate("assets")}
      beforeFields={
        modelsError ? (
          <section className="add-asset-generate-section">
            <p className="add-asset-generate-error">{modelsError}</p>
          </section>
        ) : models == null ? (
          <section className="add-asset-generate-section">
            <p className="muted">Loading {modelLabel.toLowerCase()}…</p>
          </section>
        ) : models.length === 0 ? (
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
      <>
        <GenerateTargetButton
          target="Assets"
          disabled={!canGenerate}
          running={false}
          onClick={() => handleGenerate("assets")}
        />
        {allowTimelineTarget ? (
          <GenerateTargetButton
            target="Timeline"
            disabled={!canGenerate}
            running={false}
            onClick={() => handleGenerate("timeline")}
          />
        ) : null}
      </>
    ) : null;

  return { fields, generateAction, cloneAction };
}
