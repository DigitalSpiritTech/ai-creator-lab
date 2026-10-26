/**
 * A small OpenAPI 3.0 schema checker for Router request bodies: types, nullable, enums, required,
 * closed objects, string and array bounds, numeric bounds, `$ref`, and `allOf`/`anyOf`/`oneOf`.
 * It reports problems instead of throwing so a caller can show them per field.
 * @packageDocumentation
 */

type JsonSchema = Record<string, unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Resolves a local `#/components/...` reference inside the document. */
function resolveRef(document: unknown, ref: string): JsonSchema | undefined {
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = document;
  for (const raw of ref.slice(2).split("/")) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    node = isObject(node) ? node[segment] : undefined;
  }
  return isObject(node) ? node : undefined;
}

/** The JSON request body schema of the model's run operation, if the document publishes one. */
export function requestBodySchema(document: unknown): JsonSchema | undefined {
  if (!isObject(document) || !isObject(document.paths)) return undefined;
  for (const path of Object.values(document.paths)) {
    if (!isObject(path) || !isObject(path.post)) continue;
    const body = path.post.requestBody;
    const schema = isObject(body) && isObject(body.content) && isObject(body.content["application/json"]) ? body.content["application/json"].schema : undefined;
    if (isObject(schema)) return schema;
  }
  return undefined;
}

function typeMatches(type: string, value: unknown): boolean {
  if (type === "object") return isObject(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  return true;
}

/** Lists every way `value` breaks `schema`; an empty list means it fits. */
export function checkAgainstSchema(value: unknown, schema: JsonSchema, document: unknown, path = "body", depth = 0): string[] {
  if (depth > 32) return [];
  if (typeof schema.$ref === "string") {
    const target = resolveRef(document, schema.$ref);
    return target ? checkAgainstSchema(value, target, document, path, depth + 1) : [];
  }
  const problems: string[] = [];
  if (value === null) return schema.nullable === true || schema.type === undefined ? [] : [`${path} cannot be null.`];
  for (const part of Array.isArray(schema.allOf) ? schema.allOf : []) {
    if (isObject(part)) problems.push(...checkAgainstSchema(value, part, document, path, depth + 1));
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    const options = Array.isArray(schema[key]) ? (schema[key] as unknown[]).filter(isObject) : [];
    if (options.length && !options.some((option) => checkAgainstSchema(value, option, document, path, depth + 1).length === 0)) {
      problems.push(`${path} matches none of the allowed shapes.`);
    }
  }
  if (typeof schema.type === "string" && !typeMatches(schema.type, value)) return [...problems, `${path} must be ${schema.type}.`];
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => option === value)) {
    problems.push(`${path} must be one of ${schema.enum.map(String).join(", ")}.`);
  }
  if (typeof value === "string") {
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) problems.push(`${path} is longer than ${schema.maxLength} characters.`);
    if (typeof schema.minLength === "number" && value.length < schema.minLength) problems.push(`${path} is shorter than ${schema.minLength} characters.`);
  }
  if (typeof value === "number") {
    if (typeof schema.maximum === "number" && value > schema.maximum) problems.push(`${path} must be at most ${schema.maximum}.`);
    if (typeof schema.minimum === "number" && value < schema.minimum) problems.push(`${path} must be at least ${schema.minimum}.`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) problems.push(`${path} has more than ${schema.maxItems} items.`);
    if (typeof schema.minItems === "number" && value.length < schema.minItems) problems.push(`${path} needs at least ${schema.minItems} items.`);
    if (isObject(schema.items)) value.forEach((item, index) => problems.push(...checkAgainstSchema(item, schema.items as JsonSchema, document, `${path}.${index}`, depth + 1)));
  }
  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const name of Array.isArray(schema.required) ? schema.required : []) {
      if (typeof name === "string" && !(name in value)) problems.push(`${path}.${name} is required.`);
    }
    for (const [name, child] of Object.entries(value)) {
      const definition = properties[name];
      if (isObject(definition)) problems.push(...checkAgainstSchema(child, definition, document, `${path}.${name}`, depth + 1));
      else if (schema.additionalProperties === false) problems.push(`${path}.${name} is not an accepted field.`);
    }
  }
  return problems;
}
