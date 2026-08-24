/**
 * Render a list of schema fields. File fields use `renderFileField` when provided.
 */
import type { ReactNode } from "react";
import type { ReplicateInputField } from "../replicate/replicateClient";
import { isAnyFileField } from "./schemaForm";
import { SchemaScalarField } from "./SchemaScalarField";

export type SchemaFieldsProps = {
  fields: ReplicateInputField[];
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
  disabled?: boolean;
  showAspectPreview?: boolean;
  /** Lab file/media slots — until shared media slot exists. */
  renderFileField?: (field: ReplicateInputField) => ReactNode;
};

export function SchemaFields({
  fields,
  values,
  onChange,
  disabled = false,
  showAspectPreview = false,
  renderFileField,
}: SchemaFieldsProps) {
  return (
    <>
      {fields.map((field) => {
        if (isAnyFileField(field)) {
          return (
            <div key={field.name}>
              {renderFileField?.(field) ?? null}
            </div>
          );
        }
        return (
          <SchemaScalarField
            key={field.name}
            field={field}
            values={values}
            onChange={onChange}
            disabled={disabled}
            showAspectPreview={showAspectPreview}
          />
        );
      })}
    </>
  );
}
