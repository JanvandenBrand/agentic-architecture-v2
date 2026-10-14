import { readFile } from "node:fs/promises";
import path from "node:path";

import fg from "fast-glob";
import { minimatch } from "minimatch";

import { isRecord } from "../common/json.js";
import { toRepositoryPath } from "../common/path.js";
import { hashArtifactBytes } from "./hash.js";
import {
  createSchemaRegistry,
  getSchemaEntry,
  validateRecordSchema,
  type SchemaRegistry,
} from "../schema/validator.js";
import type { ValidationError } from "../types.js";

export interface LoadedRecord {
  file: string;
  absolutePath: string;
  snapshotSha256: string;
  value: Record<string, unknown>;
}

export interface LoadedCaseRecords {
  records: LoadedRecord[];
  errors: ValidationError[];
}

function syntaxError(file: string, message: string): ValidationError {
  return {
    file,
    invariant: "json-syntax",
    message,
    remediation: "Correct the JSON syntax and run validation again.",
  };
}

function expectedRecordType(
  registry: SchemaRegistry,
  file: string,
  schemaVersion: unknown,
): string | undefined {
  return registry.catalogue.schemas.find((entry) =>
    entry.schemaVersion === schemaVersion &&
    entry.patterns.some((pattern) => minimatch(file, pattern)),
  )?.recordType;
}

function locationErrors(
  registry: SchemaRegistry,
  file: string,
  schemaVersion: unknown,
  recordType: string,
): ValidationError[] {
  const entry = typeof schemaVersion === "string"
    ? getSchemaEntry(registry, schemaVersion, recordType)
    : undefined;
  if (!entry || entry.patterns.some((pattern) => minimatch(file, pattern))) {
    return [];
  }
  return [
    {
      file,
      invariant: "record-location",
      message: `Record type "${recordType}" is not allowed at this path.`,
      remediation: `Move it to a catalogued path: ${entry.patterns.join(" or ")}.`,
    },
  ];
}

function validateParsedRecord(
  registry: SchemaRegistry,
  file: string,
  value: unknown,
): { record?: LoadedRecord["value"]; errors: ValidationError[] } {
  const expected = expectedRecordType(
    registry, file, isRecord(value) ? value.schemaVersion : undefined,
  );
  const schemaErrors = validateRecordSchema(registry, file, value, expected);
  if (!isRecord(value)) {
    return { errors: schemaErrors };
  }

  const recordType =
    typeof value.recordType === "string" ? value.recordType : undefined;
  const errors = [
    ...schemaErrors,
    ...(recordType ? locationErrors(registry, file, value.schemaVersion, recordType) : []),
  ];
  return schemaErrors.length === 0
    ? { record: value, errors }
    : { errors };
}

async function loadJsonFile(
  registry: SchemaRegistry,
  caseRoot: string,
  file: string,
): Promise<LoadedCaseRecords> {
  const absolutePath = path.join(caseRoot, file);
  const content = await readFile(absolutePath);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content));
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    return {
      records: [],
      errors: [syntaxError(file, `Invalid JSON: ${error.message}`)],
    };
  }

  if (file.startsWith("input/")) {
    return { records: [], errors: [] };
  }

  const validated = validateParsedRecord(registry, file, value);
  return {
    records: validated.record
      ? [
          {
            file,
            absolutePath,
            snapshotSha256: hashArtifactBytes(absolutePath, content),
            value: validated.record,
          },
        ]
      : [],
    errors: validated.errors,
  };
}

async function loadJsonLinesFile(
  registry: SchemaRegistry,
  caseRoot: string,
  file: string,
): Promise<LoadedCaseRecords> {
  const absolutePath = path.join(caseRoot, file);
  const content = await readFile(absolutePath);
  const snapshotSha256 = hashArtifactBytes(absolutePath, content);
  const lines = new TextDecoder("utf-8", { fatal: true })
    .decode(content)
    .split(/\r?\n/u);
  const records: LoadedRecord[] = [];
  const errors: ValidationError[] = [];

  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") {
      continue;
    }
    const lineFile = `${file}:${index + 1}`;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
      errors.push(syntaxError(lineFile, `Invalid JSONL event: ${error.message}`));
      continue;
    }

    if (file.startsWith("input/")) {
      continue;
    }
    const expected = expectedRecordType(
      registry, file, isRecord(value) ? value.schemaVersion : undefined,
    );
    const schemaErrors = validateRecordSchema(registry, lineFile, value, expected);
    const recordType =
      isRecord(value) && typeof value.recordType === "string"
        ? value.recordType
        : undefined;
    errors.push(
      ...schemaErrors,
      ...(recordType && isRecord(value)
        ? locationErrors(registry, file, value.schemaVersion, recordType)
        : []),
    );
    if (schemaErrors.length === 0 && isRecord(value)) {
      records.push({ file: lineFile, absolutePath, snapshotSha256, value });
    }
  }

  return { records, errors };
}

export async function loadCaseRecords(
  repositoryRoot: string,
  caseRoot: string,
): Promise<LoadedCaseRecords> {
  const registry = await createSchemaRegistry(repositoryRoot);
  const files = await fg(["**/*.json", "**/*.jsonl"], {
    cwd: caseRoot,
    onlyFiles: true,
    followSymbolicLinks: false,
  });
  const loaded = await Promise.all(
    files.map((relativeFile) => {
      const file = toRepositoryPath(relativeFile);
      return file.endsWith(".jsonl")
        ? loadJsonLinesFile(registry, caseRoot, file)
        : loadJsonFile(registry, caseRoot, file);
    }),
  );

  return {
    records: loaded.flatMap(({ records }) => records),
    errors: [
      ...registry.errors,
      ...loaded.flatMap(({ errors }) => errors),
    ],
  };
}
