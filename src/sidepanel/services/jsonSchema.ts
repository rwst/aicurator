// Minimal JSON Schema validator. Subset:
//   - type: 'object' | 'array' | 'string' | 'number' | 'integer'
//           | 'boolean' | 'null'
//   - properties + required (for objects)
//   - items (for arrays)
//   - enum (literal value matching)
//   - additionalProperties (boolean or sub-schema)
//
// Throws on first failure with a path-prefixed message. We use this to
// guard structured-output payloads from providers that don't enforce
// schemas (Anthropic) or that enforce them loosely.

export type JsonSchema = {
  type?:
    | 'object'
    | 'array'
    | 'string'
    | 'number'
    | 'integer'
    | 'boolean'
    | 'null';
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  items?: JsonSchema;
  enum?: readonly unknown[];
  additionalProperties?: boolean | JsonSchema;
};

function fail(path: string, msg: string): never {
  throw new Error(`${path}: ${msg}`);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => deepEqual(ao[k], bo[k]));
  }
  return false;
}

export function validate(value: unknown, schema: JsonSchema, path = '$'): void {
  if (schema.enum) {
    if (!schema.enum.some((e) => deepEqual(value, e))) {
      fail(path, `value not in enum ${JSON.stringify(schema.enum)}`);
    }
  }
  switch (schema.type) {
    case undefined:
      return;
    case 'null':
      if (value !== null) fail(path, `expected null, got ${typeof value}`);
      return;
    case 'string':
      if (typeof value !== 'string')
        fail(path, `expected string, got ${typeof value}`);
      return;
    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value))
        fail(path, `expected number, got ${typeof value}`);
      return;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value))
        fail(path, `expected integer, got ${value}`);
      return;
    case 'boolean':
      if (typeof value !== 'boolean')
        fail(path, `expected boolean, got ${typeof value}`);
      return;
    case 'array':
      if (!Array.isArray(value))
        fail(path, `expected array, got ${typeof value}`);
      if (schema.items) {
        for (let i = 0; i < (value as unknown[]).length; i += 1) {
          validate((value as unknown[])[i], schema.items, `${path}[${i}]`);
        }
      }
      return;
    case 'object':
      if (
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value)
      ) {
        fail(path, `expected object, got ${value === null ? 'null' : typeof value}`);
      }
      const obj = value as Record<string, unknown>;
      for (const k of schema.required ?? []) {
        if (!(k in obj)) fail(`${path}.${k}`, 'required key missing');
      }
      const propSchemas = schema.properties ?? {};
      for (const [k, v] of Object.entries(obj)) {
        const sub = propSchemas[k];
        if (sub) {
          validate(v, sub, `${path}.${k}`);
        } else if (schema.additionalProperties === false) {
          fail(`${path}.${k}`, 'unexpected additional property');
        } else if (
          typeof schema.additionalProperties === 'object' &&
          schema.additionalProperties !== null
        ) {
          validate(v, schema.additionalProperties, `${path}.${k}`);
        }
      }
      return;
  }
}
