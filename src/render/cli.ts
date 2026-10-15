#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import { Command, CommanderError } from "commander";

import { resolveCasePath } from "../case/path.js";
import {
  RenderError,
  renderPhaseHtml,
  renderReviewHtml,
  renderSolutionOverview,
} from "./index.js";

interface PhaseCliOptions {
  case: string;
  metadata?: string[];
  output: string;
  phase: string;
  requireVisualDiagrams: boolean;
  root: string;
  source: string;
}

interface OverviewCliOptions {
  case: string;
  output: string;
  root: string;
}

interface ReviewCliOptions {
  case: string;
  metadata: string;
  output: string;
  phase: string;
  reviewer: string;
  round: string;
  source: string;
  root: string;
  requireVisualDiagrams: boolean;
}

export async function runRenderCli(argv: string[]): Promise<number> {
  const program = new Command();
  program
    .name("aff-render")
    .description("Render authoritative AFF case content as safe standalone HTML.")
    .exitOverride();

  program
    .command("phase")
    .description("Render one authoritative phase Markdown document.")
    .requiredOption("--case <path>", "case path beneath cases/<case-name>")
    .requiredOption("--phase <id>", "AFF phase ID")
    .requiredOption("--source <path>", "case-relative authoritative Markdown path")
    .requiredOption("--output <path>", "case-relative HTML output path")
    .option(
      "--metadata <paths...>",
      "case-relative structured JSON metadata paths",
    )
    .option(
      "--require-visual-diagrams",
      "fail when Mermaid cannot be rendered as a reviewed static visual",
      false,
    )
    .option("--root <path>", "repository root", process.cwd())
    .action(async (options: PhaseCliOptions) => {
      const repositoryRoot = path.resolve(options.root);
      const resolved = await resolveCasePath(repositoryRoot, options.case);
      if (!resolved.caseRoot) {
        const first = resolved.errors[0];
        throw new RenderError(
          first?.message ?? "Case path is invalid.",
          first?.remediation ?? "Use cases/<case-name>.",
        );
      }
      await renderPhaseHtml({
        caseRoot: resolved.caseRoot,
        phaseId: options.phase,
        sourcePath: options.source,
        outputPath: options.output,
        metadataPaths: options.metadata ?? [],
        requireVisualDiagrams: options.requireVisualDiagrams,
      });
      console.log(`Rendered ${options.output} from ${options.source}.`);
    });

  program
    .command("review")
    .description("Render one authoritative reviewer Markdown and JSON pair before the human gate.")
    .requiredOption("--case <path>", "case path beneath cases/<case-name>")
    .requiredOption("--phase <id>", "AFF phase ID")
    .requiredOption("--reviewer <id>", "AFF-A or AFF-B")
    .requiredOption("--round <n>", "positive review round number")
    .requiredOption("--source <path>", "case-relative authoritative review Markdown path")
    .requiredOption("--metadata <path>", "matching case-relative review JSON path")
    .requiredOption("--output <path>", "matching case-relative review HTML path")
    .option("--require-visual-diagrams", "require reviewed static diagrams rather than Mermaid source", false)
    .option("--root <path>", "repository root", process.cwd())
    .action(async (options: ReviewCliOptions) => {
      if (
        (options.reviewer !== "AFF-A" && options.reviewer !== "AFF-B") ||
        !/^[1-9][0-9]*$/u.test(options.round) ||
        !Number.isSafeInteger(Number(options.round))
      ) {
        throw new RenderError(
          "Review rendering requires reviewer AFF-A or AFF-B and a positive integer round.",
          "Pass --reviewer AFF-A|AFF-B and --round <n>.",
        );
      }
      await renderReviewHtml({
        repositoryRoot: path.resolve(options.root),
        casePath: options.case,
        phaseId: options.phase,
        reviewer: options.reviewer,
        round: Number(options.round),
        sourcePath: options.source,
        metadataPath: options.metadata,
        outputPath: options.output,
        requireVisualDiagrams: options.requireVisualDiagrams,
      });
      console.log(`Rendered ${options.output} from ${options.source} and ${options.metadata}.`);
    });

  program
    .command("overview")
    .description("Render the validated cumulative case overview.")
    .requiredOption("--case <path>", "case path beneath cases/<case-name>")
    .option("--output <path>", "case-relative HTML output path", "solution-overview.html")
    .option("--root <path>", "repository root", process.cwd())
    .action(async (options: OverviewCliOptions) => {
      await renderSolutionOverview({
        repositoryRoot: path.resolve(options.root),
        casePath: options.case,
        outputPath: options.output,
      });
      console.log(`Rendered ${options.output} from validated case records.`);
    });

  try {
    await program.parseAsync(argv);
    return 0;
  } catch (error: unknown) {
    if (error instanceof CommanderError && error.exitCode === 0) {
      return 0;
    }
    if (error instanceof CommanderError) {
      return 64;
    }
    if (error instanceof RenderError) {
      console.error(`ERROR [safe-rendering] ${error.message}`);
      return 1;
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRenderCli(process.argv)
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
