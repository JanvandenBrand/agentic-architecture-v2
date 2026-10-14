import { readFile } from "node:fs/promises";
import path from "node:path";

import Ajv2020, {
  type AnySchemaObject,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { isRecord } from "../common/json.js";
import type { ValidationError } from "../types.js";
import {
  readSchemaCatalogue,
  type SchemaCatalogue,
  type SchemaCatalogueEntry,
} from "./catalogue.js";

export interface SchemaRegistry {
  catalogue: SchemaCatalogue;
  entries: Map<string, Map<string, SchemaCatalogueEntry>>;
  validators: Map<string, Map<string, ValidateFunction>>;
  errors: ValidationError[];
}

export function getSchemaEntry(
  registry: SchemaRegistry,
  schemaVersion: string,
  recordType: string,
): SchemaCatalogueEntry | undefined {
  return registry.entries.get(schemaVersion)?.get(recordType);
}

const requiredRecordTypes = new Set([
  "lifecycle-manifest",
  "input-inventory",
  "model-plan",
  "interview-decisions",
  "requirements-catalogue",
  "architecture-catalogue",
  "azure-design-catalogue",
  "implementation-catalogue",
  "release-manifest",
  "claim-catalogue",
  "deployment-attempts",
  "test-catalogue",
  "review-record",
  "human-approval",
  "regulatory-coverage",
  "run-journal-event",
]);

function parseSchema(content: string, file: string): AnySchemaObject {
  const parsed: unknown = JSON.parse(content);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`${file} must contain a JSON Schema object.`);
  }

  // Ajv validates the complete schema during addSchema/compile; this narrows its JSON input boundary.
  return parsed as AnySchemaObject;
}

function schemaError(
  file: string,
  recordType: string,
  error: ErrorObject,
): ValidationError {
  const location = error.instancePath || "/";
  return {
    file,
    invariant: "schema-validation",
    message: `${recordType} ${location}: ${error.message ?? "is invalid"}.`,
    remediation:
      "Correct the record to match its catalogued JSON Schema and schemaVersion.",
  };
}

export async function createSchemaRegistry(
  repositoryRoot: string,
): Promise<SchemaRegistry> {
  const catalogue = await readSchemaCatalogue(repositoryRoot);
  const errors: ValidationError[] = [];
  if (
    catalogue.jsonSchemaDraft !==
    "https://json-schema.org/draft/2020-12/schema"
  ) {
    errors.push({
      file: "schemas/aff/catalogue.json",
      invariant: "schema-catalogue",
      message: `Unsupported JSON Schema draft "${catalogue.jsonSchemaDraft}".`,
      remediation: "Use JSON Schema Draft 2020-12 for AFF contracts.",
    });
  }
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
  });
  addFormats(ajv);

  const schemaRoot = path.join(repositoryRoot, "schemas", "aff");
  const entries = new Map<string, Map<string, SchemaCatalogueEntry>>();
  const validators = new Map<string, Map<string, ValidateFunction>>();
  const loadedSharedVersions = new Set<string>();
  for (const version of catalogue.supportedContractVersions) {
    entries.set(version, new Map());
    validators.set(version, new Map());
    const sharedFile = `schemas/aff/${version}/shared.schema.json`;
    const expectedSharedId = `https://github.com/aramsmith/agentic-architecture-v2/${sharedFile}`;
    try {
      const sharedPath = path.join(schemaRoot, version, "shared.schema.json");
      const shared = parseSchema(await readFile(sharedPath, "utf8"), sharedPath);
      if (shared.$id !== expectedSharedId) {
        errors.push({
          file: sharedFile,
          invariant: "schema-catalogue",
          message: "Shared schema $id does not match its stable repository URL.",
          remediation: `Set $id to "${expectedSharedId}".`,
        });
        continue;
      }
      if (
        !isRecord(shared.$defs) ||
        !isRecord(shared.$defs.schemaVersion) ||
        shared.$defs.schemaVersion.const !== version
      ) {
        errors.push({
          file: sharedFile,
          invariant: "schema-catalogue",
          message: `Shared schemaVersion must be exactly "${version}".`,
          remediation: "Keep each shared schema bound to its own contract version.",
        });
        continue;
      }
      ajv.addSchema(shared, expectedSharedId);
      loadedSharedVersions.add(version);
    } catch (error: unknown) {
      errors.push({
        file: sharedFile,
        invariant: "schema-catalogue",
        message: `Cannot load shared schema: ${error instanceof Error ? error.message : String(error)}`,
        remediation: `Restore a valid shared schema for contract version "${version}".`,
      });
    }
  }

  const seen = new Map<string, Set<string>>();
  for (const entry of catalogue.schemas) {
    const version = entry.schemaVersion;
    const versionEntries = entries.get(version)!;
    const seenTypes = seen.get(version) ?? new Set<string>();
    seen.set(version, seenTypes);
    if (seenTypes.has(entry.recordType)) {
      errors.push({
        file: "schemas/aff/catalogue.json",
        invariant: "schema-catalogue",
        message: `Schema catalogue repeats recordType "${entry.recordType}" for version "${version}".`,
        remediation: "Keep exactly one schema entry for each schemaVersion and recordType pair.",
      });
      continue;
    }
    seenTypes.add(entry.recordType);
    if (
      !entry.file.startsWith(`${version}/`) ||
      entry.file.includes("..") ||
      entry.file.includes("\\") ||
      path.isAbsolute(entry.file)
    ) {
      errors.push({
        file: "schemas/aff/catalogue.json",
        invariant: "schema-catalogue",
        message: `Schema file "${entry.file}" is outside its declared version directory "${version}".`,
        remediation: `Store it beneath schemas/aff/${version}/ using a repository-relative path.`,
      });
      continue;
    }
    const schemaFile = `schemas/aff/${entry.file}`;
    const expectedId = `https://github.com/aramsmith/agentic-architecture-v2/schemas/aff/${entry.file}`;
    try {
      const schemaPath = path.join(schemaRoot, entry.file);
      const schema = parseSchema(await readFile(schemaPath, "utf8"), schemaPath);
      versionEntries.set(entry.recordType, entry);
      if (schema.$id !== expectedId) {
        errors.push({
          file: schemaFile,
          invariant: "schema-catalogue",
          message: `Schema $id "${String(schema.$id)}" does not match its stable catalogue URL.`,
          remediation: `Set $id to "${expectedId}".`,
        });
        continue;
      }
      if (
        !isRecord(schema.properties) ||
        !isRecord(schema.properties.schemaVersion) ||
        schema.properties.schemaVersion.$ref !== "shared.schema.json#/$defs/schemaVersion"
      ) {
        errors.push({
          file: schemaFile,
          invariant: "schema-catalogue",
          message: "Record schema does not reference its version's required schemaVersion field.",
          remediation:
            "Reference shared.schema.json#/$defs/schemaVersion from properties.schemaVersion.",
        });
        continue;
      }
      if (loadedSharedVersions.has(version)) {
        validators.get(version)!.set(entry.recordType, ajv.compile(schema));
      }
    } catch (error: unknown) {
      errors.push({
        file: schemaFile,
        invariant: "schema-catalogue",
        message: `Cannot load or compile schema: ${error instanceof Error ? error.message : String(error)}`,
        remediation: `Restore a valid schema and references for contract version "${version}".`,
      });
    }
  }

  for (const version of catalogue.supportedContractVersions) {
    for (const recordType of requiredRecordTypes) {
      if (!entries.get(version)!.has(recordType)) {
        errors.push({
          file: "schemas/aff/catalogue.json",
          invariant: "schema-catalogue",
          message: `Required AFF record type "${recordType}" has no catalogue entry for version "${version}".`,
          remediation:
            "Add a versioned Draft 2020-12 schema and catalogue mapping for the record.",
        });
      }
    }
  }

  return { catalogue, entries, validators, errors };
}

export function validateRecordSchema(
  registry: SchemaRegistry,
  file: string,
  record: unknown,
  expectedRecordType?: string,
): ValidationError[] {
  if (
    typeof record !== "object" ||
    record === null ||
    Array.isArray(record) ||
    !("recordType" in record) ||
    typeof record.recordType !== "string"
  ) {
    return [
      {
        file,
        invariant: "schema-validation",
        message: 'Structured AFF records require a string "recordType" field.',
        remediation:
          "Add recordType and schemaVersion fields from the schema catalogue.",
      },
    ];
  }

  const recordType = record.recordType;
  if (expectedRecordType && recordType !== expectedRecordType) {
    return [
      {
        file,
        invariant: "schema-validation",
        message: `Expected recordType "${expectedRecordType}" but found "${recordType}".`,
        remediation: `Set recordType to "${expectedRecordType}" for this file.`,
      },
    ];
  }

  if (!("schemaVersion" in record) || typeof record.schemaVersion !== "string") {
    return [{
      file,
      invariant: "schema-validation",
      message: 'Structured AFF records require a string "schemaVersion" field.',
      remediation: `Declare one of the supported schema versions: ${registry.catalogue.supportedContractVersions.join(", ")}.`,
    }];
  }
  const version = record.schemaVersion;
  const versionValidators = registry.validators.get(version);
  const validator = versionValidators?.get(recordType);
  if (!validator) {
    return [
      {
        file,
        invariant: "schema-validation",
        message: `No schema for schemaVersion "${version}" and recordType "${recordType}" in schemas/aff/catalogue.json.`,
        remediation:
          `Use a supported schemaVersion (${registry.catalogue.supportedContractVersions.join(", ")}) and recordType (${[...(registry.entries.get(version)?.keys() ?? requiredRecordTypes)].join(", ")}).`,
      },
    ];
  }

  return validator(record)
    ? []
    : (validator.errors ?? []).map((error) =>
        schemaError(file, recordType, error),
      );
}
