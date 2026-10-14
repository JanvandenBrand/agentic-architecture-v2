import { readFile } from "node:fs/promises";
import path from "node:path";

export type RecordFormat = "json" | "jsonl";
export type ContractVersion = "1.0.0" | "1.1.0";

export interface SchemaCatalogueEntry {
  schemaVersion: ContractVersion;
  recordType: string;
  file: string;
  format: RecordFormat;
  patterns: string[];
}

export interface SchemaCatalogue {
  contractVersion: ContractVersion;
  supportedContractVersions: ContractVersion[];
  jsonSchemaDraft: string;
  schemas: SchemaCatalogueEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isContractVersion(value: unknown): value is ContractVersion {
  return value === "1.0.0" || value === "1.1.0";
}

function isEntry(value: unknown): value is SchemaCatalogueEntry {
  return (
    isRecord(value) &&
    isContractVersion(value.schemaVersion) &&
    typeof value.recordType === "string" &&
    typeof value.file === "string" &&
    (value.format === "json" || value.format === "jsonl") &&
    Array.isArray(value.patterns) &&
    value.patterns.every((pattern) => typeof pattern === "string")
  );
}

function isCatalogue(value: unknown): value is SchemaCatalogue {
  if (
    !isRecord(value) ||
    !isContractVersion(value.contractVersion) ||
    !Array.isArray(value.supportedContractVersions) ||
    !value.supportedContractVersions.every(isContractVersion) ||
    typeof value.jsonSchemaDraft !== "string" ||
    !Array.isArray(value.schemas) ||
    !value.schemas.every(isEntry)
  ) {
    return false;
  }
  const supportedVersions = new Set(value.supportedContractVersions);
  return (
    supportedVersions.size === value.supportedContractVersions.length &&
    supportedVersions.has(value.contractVersion) &&
    value.schemas.every((entry) => supportedVersions.has(entry.schemaVersion))
  );
}

export async function readSchemaCatalogue(
  repositoryRoot: string,
): Promise<SchemaCatalogue> {
  const file = path.join(repositoryRoot, "schemas", "aff", "catalogue.json");
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!isCatalogue(parsed)) {
    throw new TypeError(
      "schemas/aff/catalogue.json does not contain a valid schema catalogue.",
    );
  }
  return parsed;
}
