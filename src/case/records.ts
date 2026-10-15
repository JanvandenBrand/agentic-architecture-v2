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
    remediation: "Correct the JSON syntax or UTF-8 encoding and run validation again.",
  };
}

export function isCataloguedRecordPath(
  registry: SchemaRegistry,
  file: string,
): boolean {
  return expectedRecordType(registry, file.replaceAll("\\", "/"), undefined) !== undefined;
}

function expectedRecordType(
  registry: SchemaRegistry,
  file: string,
  schemaVersion: unknown,
): string | undefined {
  const matches = registry.catalogue.schemas.filter((entry) =>
    registry.catalogue.supportedContractVersions.includes(entry.schemaVersion) &&
    entry.patterns.some((pattern) => minimatch(file, pattern)),
  );
  // Paths reserved by another version still require AFF validation; schema
  // dispatch and location checks below never fall back to that version.
  return (matches.find((entry) => entry.schemaVersion === schemaVersion) ?? matches[0])?.recordType;
}

function locationErrors(
  registry: SchemaRegistry,
  file: string,
  schemaVersion: unknown,
  recordType: string,
  diagnosticFile = file,
): ValidationError[] {
  const entry = typeof schemaVersion === "string"
    ? getSchemaEntry(registry, schemaVersion, recordType)
    : undefined;
  const patterns = entry?.patterns ?? registry.catalogue.schemas
    .filter((candidate) =>
      candidate.recordType === recordType &&
      registry.catalogue.supportedContractVersions.includes(candidate.schemaVersion),
    )
    .flatMap((candidate) => candidate.patterns);
  if (patterns.length === 0 || patterns.some((pattern) => minimatch(file, pattern))) {
    return [];
  }
  return [
    {
      file: diagnosticFile,
      invariant: "record-location",
      message: `Record type "${recordType}" is not allowed at this path.`,
      remediation: `Move it to a catalogued path: ${[...new Set(patterns)].join(" or ")}.`,
    },
  ];
}

function validateParsedRecord(
  registry: SchemaRegistry,
  file: string,
  value: unknown,
  diagnosticFile = file,
): { record?: LoadedRecord["value"]; errors: ValidationError[] } {
  const expected = expectedRecordType(
    registry, file, isRecord(value) ? value.schemaVersion : undefined,
  );
  const recordType =
    isRecord(value) && typeof value.recordType === "string" ? value.recordType : undefined;
  const knownRecordType = recordType !== undefined &&
    registry.catalogue.schemas.some((entry) =>
      entry.recordType === recordType &&
      registry.catalogue.supportedContractVersions.includes(entry.schemaVersion),
    );
  if (!expected && !knownRecordType) {
    return { errors: [] };
  }
  const schemaErrors = validateRecordSchema(registry, diagnosticFile, value, expected);
  if (!isRecord(value)) {
    return { errors: schemaErrors };
  }

  const errors = [
    ...schemaErrors,
    ...(recordType ? locationErrors(registry, file, value.schemaVersion, recordType, diagnosticFile) : []),
  ];
  return errors.length === 0
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
    if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) {
      throw error;
    }
    return {
      records: [],
      errors: [syntaxError(file, `Invalid JSON or UTF-8: ${error.message}`)],
    };
  }

  if (file.startsWith("input/")) {
    return { records: [], errors: [] };
  }

  const validated = validateParsedRecord(registry, file, value);
  if (!validated.record) {
    return { records: [], errors: validated.errors };
  }
  let snapshotSha256: string;
  try {
    snapshotSha256 = hashArtifactBytes(absolutePath, content);
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) {
      throw error;
    }
    return { records: [], errors: [syntaxError(file, `Cannot canonicalize JSON: ${error.message}`)] };
  }
  return {
    records: [{ file, absolutePath, snapshotSha256, value: validated.record }],
    errors: validated.errors,
  };
}

function* byteLines(content: Buffer): Generator<Buffer> {
  let start = 0;
  let end: number;
  while ((end = content.indexOf(0x0a, start)) !== -1) {
    yield content.subarray(start, end);
    start = end + 1;
  }
  yield content.subarray(start);
}

async function loadJsonLinesFile(
  registry: SchemaRegistry,
  caseRoot: string,
  file: string,
): Promise<LoadedCaseRecords> {
  const absolutePath = path.join(caseRoot, file);
  const content = await readFile(absolutePath);
  const parsedRecords: { file: string; value: LoadedRecord["value"] }[] = [];
  const errors: ValidationError[] = [];
  let parseFailed = false;
  let index = 0;

  for (const bytes of byteLines(content)) {
    const lineFile = `${file}:${++index}`;
    let value: unknown;
    try {
      // A BOM is valid only at the beginning of the file, matching canonical hashing.
      const line = new TextDecoder("utf-8", { fatal: true, ignoreBOM: index > 1 }).decode(bytes);
      if (line.trim() === "") {
        continue;
      }
      value = JSON.parse(line);
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) {
        throw error;
      }
      errors.push(syntaxError(lineFile, `Invalid JSONL or UTF-8: ${error.message}`));
      parseFailed = true;
      continue;
    }

    if (file.startsWith("input/")) {
      continue;
    }
    const validated = validateParsedRecord(registry, file, value, lineFile);
    errors.push(...validated.errors);
    if (validated.record) {
      parsedRecords.push({ file: lineFile, value: validated.record });
    }
  }

  if (parseFailed || parsedRecords.length === 0) {
    return { records: [], errors };
  }
  let snapshotSha256: string;
  try {
    snapshotSha256 = hashArtifactBytes(absolutePath, content);
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) {
      throw error;
    }
    return {
      records: [],
      errors: [...errors, syntaxError(file, `Cannot canonicalize JSONL: ${error.message}`)],
    };
  }
  return {
    records: parsedRecords.map((record) => ({ ...record, absolutePath, snapshotSha256 })),
    errors,
  };
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
