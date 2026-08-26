/**
 * Shared scalar/enum/slider/aspect schema field (non-file).
 * File/media slots stay in Lab panels until the shared media slot lands.
 */
import type { ReplicateInputField } from "../replicate/replicateClient";
import {
  isProjectAspectRatio,
  pickAspectChooserValue,
  projectAspectCss,
} from "../project/aspectRatios";
import { AspectRatioChooser } from "../ui/AspectRatioChooser";
import {
  aspectChooserOptionsForField,
  clampNumericString,
  formatDefaultLabel,
  hasSliderRange,
  isPromptLikeField,
  resolveFormValue,
  sliderStep,
} from "./schemaForm";

export type SchemaScalarFieldProps = {
  field: ReplicateInputField;
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
  disabled?: boolean;
  /** Show a small aspect-ratio preview box (Blue Lab). */
  showAspectPreview?: boolean;
  /** Schema name/type/title/help. Off when a section header already names the field. */
  showFieldChrome?: boolean;
};

export function SchemaScalarField({
  field,
  values,
  onChange,
  disabled = false,
  showAspectPreview = false,
  showFieldChrome = true,
}: SchemaScalarFieldProps) {
  const label = field.title || field.name;
  const value = resolveFormValue(field, values);
  const enums = field.enumValues ?? null;
  const enumGroups =
    field.enumGroups?.filter((group) => group.values.length > 0) ?? [];
  const groupedEnumIds = new Set(enumGroups.flatMap((group) => group.values));
  const ungroupedEnums = (enums ?? []).filter((opt) => !groupedEnumIds.has(opt));
  const setValue = (next: string) => onChange(field.name, next);
  const showSlider = hasSliderRange(field);
  const defaultLabel = formatDefaultLabel(field);
  const aspectOpts = aspectChooserOptionsForField(field);
  const rangeLabel =
    field.minimum != null && field.maximum != null
      ? `(minimum: ${field.minimum}, maximum: ${field.maximum})`
      : null;
  const isPromptLike = isPromptLikeField(field);

  if (aspectOpts.length > 0) {
    const aspectValue = pickAspectChooserValue(aspectOpts, value);
    const aspectCss =
      showAspectPreview && isProjectAspectRatio(aspectValue)
        ? projectAspectCss(aspectValue)
        : null;
    return (
      <div
        key={field.name}
        className={`lab-replicate-run-field${showFieldChrome ? "" : " is-bare"}`}
      >
        {showFieldChrome ? (
          <>
            <div className="lab-replicate-run-field-head">
              <span>
                <span className="lab-replicate-run-field-name">{field.name}</span>
                <span className="muted">
                  {" "}
                  {field.typeName}
                  {field.required ? " · required" : ""}
                </span>
              </span>
            </div>
            {label !== field.name ? (
              <div className="muted lab-replicate-run-field-title">{label}</div>
            ) : null}
          </>
        ) : null}
        <AspectRatioChooser
          value={aspectValue}
          options={aspectOpts}
          disabled={disabled}
          onChange={setValue}
        />
        {aspectCss ? (
          <span
            className="lab-replicate-aspect-preview"
            style={{ aspectRatio: aspectCss }}
          />
        ) : null}
        {showFieldChrome && field.description ? (
          <p className="muted lab-replicate-run-help">{field.description}</p>
        ) : null}
        {showFieldChrome && defaultLabel != null ? (
          <p className="muted lab-replicate-run-default">
            Default: {defaultLabel}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div
      key={field.name}
      className={`lab-replicate-run-field${showFieldChrome ? "" : " is-bare"}`}
    >
      {field.typeName === "boolean" ? (
        <label className="lab-replicate-run-check">
          <input
            type="checkbox"
            checked={value === "true"}
            disabled={disabled}
            onChange={(e) => setValue(e.target.checked ? "true" : "false")}
          />
          <span>
            <span className="lab-replicate-run-field-name">
              {showFieldChrome ? field.name : label}
            </span>
            {showFieldChrome ? (
              <span className="muted">
                {" "}
                {field.typeName}
                {field.required ? " · required" : ""}
              </span>
            ) : null}
          </span>
        </label>
      ) : (
        <>
          {showFieldChrome ? (
            <>
              <div className="lab-replicate-run-field-head">
                <span>
                  <span className="lab-replicate-run-field-name">
                    {field.name}
                  </span>
                  <span className="muted">
                    {" "}
                    {field.typeName}
                    {field.required ? " · required" : ""}
                  </span>
                </span>
                {rangeLabel ? (
                  <span className="muted lab-replicate-run-range-label">
                    {rangeLabel}
                  </span>
                ) : null}
              </div>
              {label !== field.name ? (
                <div className="muted lab-replicate-run-field-title">{label}</div>
              ) : null}
            </>
          ) : null}

          {enums && enums.length > 0 ? (
            <select
              className="control"
              aria-label={showFieldChrome ? undefined : label}
              value={value}
              disabled={disabled}
              onChange={(e) => setValue(e.target.value)}
            >
              {!field.required && !value ? (
                <option value="">(default)</option>
              ) : null}
              {enumGroups.length > 0
                ? (
                    <>
                      {enumGroups.map((group) => (
                        <optgroup key={group.label} label={group.label}>
                          {group.values.map((opt) => (
                            <option key={opt} value={opt}>
                              {field.enumLabels?.[opt] ?? opt}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                      {ungroupedEnums.map((opt) => (
                        <option key={opt} value={opt}>
                          {field.enumLabels?.[opt] ?? opt}
                        </option>
                      ))}
                    </>
                  )
                : enums.map((opt) => (
                    <option key={opt} value={opt}>
                      {field.enumLabels?.[opt] ?? opt}
                    </option>
                  ))}
            </select>
          ) : isPromptLike ? (
            <textarea
              className="control"
              aria-label={showFieldChrome ? undefined : label}
              rows={3}
              value={value}
              disabled={disabled}
              onChange={(e) => setValue(e.target.value)}
            />
          ) : field.typeName === "integer" || field.typeName === "number" ? (
            showSlider ? (
              <div className="lab-replicate-run-slider-row">
                <input
                  className="control lab-replicate-run-number"
                  type="number"
                  min={field.minimum ?? undefined}
                  max={field.maximum ?? undefined}
                  step={sliderStep(field)}
                  value={value}
                  disabled={disabled}
                  onChange={(e) =>
                    setValue(clampNumericString(e.target.value, field))
                  }
                />
                <input
                  className="lab-replicate-run-range"
                  type="range"
                  min={field.minimum!}
                  max={field.maximum!}
                  step={sliderStep(field)}
                  value={
                    Number.isFinite(Number(value))
                      ? Number(value)
                      : (field.minimum ?? 0)
                  }
                  disabled={disabled}
                  onChange={(e) => setValue(e.target.value)}
                />
              </div>
            ) : (
              <input
                className="control"
                type="number"
                min={field.minimum ?? undefined}
                max={field.maximum ?? undefined}
                step={field.typeName === "integer" ? 1 : "any"}
                value={value}
                disabled={disabled}
                onChange={(e) => setValue(e.target.value)}
              />
            )
          ) : (
            <input
              className="control"
              type="text"
              value={value}
              disabled={disabled}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
        </>
      )}

      {showFieldChrome && field.description ? (
        <p className="muted lab-replicate-run-help">{field.description}</p>
      ) : null}
      {showFieldChrome && defaultLabel != null ? (
        <p className="muted lab-replicate-run-default">Default: {defaultLabel}</p>
      ) : null}
    </div>
  );
}
