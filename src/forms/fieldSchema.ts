/**
 * Map service_describe FieldSchema → SchemaFields input shape.
 */
import type { ReplicateInputField } from "../replicate/replicateClient";
import type { FieldSchema } from "../services/types";

export function fieldSchemaToInputField(field: FieldSchema): ReplicateInputField {
  const kind = field.kind;
  const typeName =
    kind === "boolean"
      ? "boolean"
      : kind === "number" || kind === "integer"
        ? "number"
        : "string";
  return {
    name: field.name,
    title: field.title ?? field.name,
    typeName,
    required: field.required,
    description: field.description ?? null,
    defaultValue: field.defaultValue,
    enumValues: field.enumValues ?? null,
    minimum: field.minimum ?? null,
    maximum: field.maximum ?? null,
    fileLike: kind === "media",
    arrayItemFileLike: false,
  };
}

export function fieldSchemasToInputFields(
  fields: FieldSchema[],
): ReplicateInputField[] {
  return fields
    .filter((f) => !f.hidden)
    .map(fieldSchemaToInputField);
}
