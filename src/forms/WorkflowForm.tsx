/**
 * Shared Generate / workflow input collector.
 * Values in → onSubmit out. Dual-view Result | Form stays outside.
 * See docs/PLAN-service-and-forms.md.
 */
import type { FormEvent, ReactNode } from "react";
import type { ReplicateInputField } from "../replicate/replicateClient";
import { SchemaFields } from "./SchemaFields";

export type WorkflowFormProps = {
  fields: ReplicateInputField[];
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
  disabled?: boolean;
  showAspectPreview?: boolean;
  /** Schema name/type/title/help. Off when a section header already names the field. */
  showFieldChrome?: boolean;
  /** Optional media slots until shared AssetRef picker exists. */
  renderFileField?: (field: ReplicateInputField) => ReactNode;
  /** Extra chrome above/below schema (model optgroups, intent-specific). */
  beforeFields?: ReactNode;
  afterFields?: ReactNode;
  onSubmit?: () => void;
  className?: string;
  children?: ReactNode;
};

export function WorkflowForm({
  fields,
  values,
  onChange,
  disabled = false,
  showAspectPreview = false,
  showFieldChrome = true,
  renderFileField,
  beforeFields,
  afterFields,
  onSubmit,
  className,
  children,
}: WorkflowFormProps) {
  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    onSubmit?.();
  };

  return (
    <form className={className} onSubmit={handleSubmit}>
      {beforeFields}
      <SchemaFields
        fields={fields}
        values={values}
        onChange={onChange}
        disabled={disabled}
        showAspectPreview={showAspectPreview}
        showFieldChrome={showFieldChrome}
        renderFileField={renderFileField}
      />
      {afterFields}
      {children}
    </form>
  );
}
