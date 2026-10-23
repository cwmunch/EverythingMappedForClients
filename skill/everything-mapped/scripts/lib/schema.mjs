// Loading the intake schema from disk (FORMAT.md section 9).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// skill/everything-mapped/schema, found relative to this file (scripts/lib/).
export const DEFAULT_SCHEMA_DIR = path.resolve(fileURLToPath(new URL('../../schema/', import.meta.url)));
export const DEFAULT_SCHEMA_PATH = path.join(DEFAULT_SCHEMA_DIR, 'intake-schema.json');

const REQUIRED_LISTS = ['languages', 'levels', 'areas', 'types', 'moduleOrder', 'files', 'modules'];
const REQUIRED_OBJECTS = ['depths', 'weights', 'statusScores', 'generatedFiles'];

function assertSchemaShape(schema, schemaPath) {
  const problems = [];
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new Error(`The schema in ${schemaPath} is not a JSON object.`);
  }
  if (typeof schema.schema !== 'string') problems.push('schema');
  for (const key of REQUIRED_LISTS) if (!Array.isArray(schema[key])) problems.push(key);
  for (const key of REQUIRED_OBJECTS) {
    if (typeof schema[key] !== 'object' || schema[key] === null || Array.isArray(schema[key])) problems.push(key);
  }
  if (problems.length > 0) throw new Error(`The schema in ${schemaPath} is missing or has a wrong type for: ${problems.join(', ')}.`);
}

export function loadSchema(schemaPath = DEFAULT_SCHEMA_PATH) {
  let schema;
  try {
    schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`Cannot read the schema ${schemaPath}: ${error.message}`);
  }
  assertSchemaShape(schema, schemaPath);
  return schema;
}
