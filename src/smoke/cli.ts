#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import { Command, CommanderError } from "commander";

import { runContosoSmoke, SmokeError } from "./contoso.js";

interface SmokeCliOptions {
  keepOutput?: string | boolean;
  root: string;
  host?: string;
  schemaVersion?: string;
}

export async function runSmokeCli(argv: string[]): Promise<number> {
  const program = new Command();
  program
    .name("smoke:contoso")
    .description(
      "Run the deterministic offline Contoso Phase 0 to opening-Phase-1 smoke journey.",
    )
    .option("--root <path>", "repository root", process.cwd())
    .option("--host <host>", "execution host: github-copilot or claude-code (requires --schema-version)")
    .option("--schema-version <version>", "case contract: 1.0.0 or 1.1.0 (requires --host)")
    .option(
      "--keep-output [path]",
      "retain generated output; default .aff-smoke/contoso",
    )
    .exitOverride();

  try {
    program.parse(argv);
    const options = program.opts<SmokeCliOptions>();
    const explicitPolicy = options.host !== undefined || options.schemaVersion !== undefined;
    if (explicitPolicy && (
      (options.host !== "github-copilot" && options.host !== "claude-code") ||
      (options.schemaVersion !== "1.0.0" && options.schemaVersion !== "1.1.0") ||
      (options.host === "claude-code" && options.schemaVersion === "1.0.0")
    )) {
      console.error("Specify both --host (github-copilot or claude-code) and --schema-version (1.0.0 or 1.1.0); 1.0.0 supports only github-copilot.");
      return 64;
    }
    const repositoryRoot = path.resolve(options.root);
    const keepOutputPath =
      typeof options.keepOutput === "string"
        ? path.resolve(options.keepOutput)
        : options.keepOutput === true
          ? path.join(repositoryRoot, ".aff-smoke", "contoso")
          : undefined;
    const result = await runContosoSmoke({
      repositoryRoot,
      ...(keepOutputPath ? { keepOutputPath } : {}),
      ...(explicitPolicy ? {
        host: options.host as "github-copilot" | "claude-code",
        schemaVersion: options.schemaVersion as "1.0.0" | "1.1.0",
      } : {}),
    });
    console.log(
      `Contoso offline smoke passed ${result.assertionsPassed} executable assertions.`,
    );
    console.log(result.boundary);
    console.log(
      `${result.assertionBasis.generatedEvidence} generated-evidence checks; ${result.assertionBasis.policyDeclarations} policy-declaration checks. Zero model/Azure counters are by construction, not runtime measurements.`,
    );
    console.log(
      keepOutputPath
        ? `Retained generated output at ${keepOutputPath}.`
        : "Generated workspace was removed after validation.",
    );
    return 0;
  } catch (error: unknown) {
    if (error instanceof CommanderError && error.exitCode === 0) {
      return 0;
    }
    if (error instanceof CommanderError) {
      return 64;
    }
    if (error instanceof SmokeError) {
      console.error(`ERROR [contoso-smoke] ${error.message}`);
      return 1;
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSmokeCli(process.argv)
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      if (!(error instanceof Error)) {
        throw error;
      }
      console.error(`FATAL: ${error.message}`);
      process.exitCode = 2;
    });
}
