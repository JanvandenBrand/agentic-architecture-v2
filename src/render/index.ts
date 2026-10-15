import { open, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import sanitizeHtml from "sanitize-html";
import writeFileAtomic from "write-file-atomic";

import { hashArtifact, hashArtifactBytes } from "../case/hash.js";
import { validateHashBindings } from "../case/hash.js";
import { resolveCasePolicy, validateLoadedCase } from "../case/index.js";
import {
  approvalModeLabel,
  resolveApprovalMode,
} from "../case/approval-mode.js";
import { validateRecordIdentity } from "../case/identity.js";
import { isCataloguedRecordPath, loadCaseRecords, type LoadedRecord } from "../case/records.js";
import { validateModelPlans, validateModelProviders, validateReviewModels } from "../case/models.js";
import {
  allReviews,
  asReview,
  asApproval,
  bindingSet,
  latestCandidateEvents,
  latestReviews,
  phaseArtifactNames,
  phaseFolders,
  type Approval,
  type Binding,
  type Review,
} from "../case/review-records.js";
import {
  resolveCasePath,
  resolveContainedCaseFile,
  resolveContainedOutputPath,
} from "../case/path.js";
import { isRecord } from "../common/json.js";
import { readLifecycle } from "../framework/lifecycle.js";
import { readHostModelDefaults } from "../framework/hosts.js";
import {
  createSchemaRegistry,
  validateRecordSchema,
  type SchemaRegistry,
} from "../schema/validator.js";

const MAX_MARKDOWN_BYTES = 1_048_576;
const MAX_METADATA_BYTES = 524_288;
const MAX_ASSET_BYTES = 5_242_880;
const MAX_OUTPUT_BYTES = 10_485_760;

const BASE_CONTENT_SECURITY_POLICY =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

function contentSecurityPolicyMeta(allowInlineScript: boolean): string {
  const scriptSource = allowInlineScript ? "'unsafe-inline'" : "'none'";
  return `<meta http-equiv="Content-Security-Policy" content="${BASE_CONTENT_SECURITY_POLICY}; script-src ${scriptSource}">`;
}

export interface RenderPhaseOptions {
  caseRoot: string;
  phaseId: string;
  sourcePath: string;
  outputPath: string;
  metadataPaths: string[];
  requireVisualDiagrams?: boolean;
}

export interface RenderOverviewOptions {
  repositoryRoot: string;
  casePath: string;
  outputPath?: string;
}

export interface RenderReviewOptions {
  repositoryRoot: string;
  casePath: string;
  phaseId: string;
  reviewer: "AFF-A" | "AFF-B";
  round: number;
  sourcePath: string;
  metadataPath: string;
  outputPath: string;
  requireVisualDiagrams?: boolean;
}

interface SourceBinding {
  path: string;
  sha256: string;
}

interface TocEntry {
  depth: number;
  id: string;
  text: string;
}

interface IdAllocator {
  allocate(preferred: string): string;
}

function createIdAllocator(): IdAllocator {
  const allocated = new Set<string>();
  return {
    allocate(preferred: string): string {
      let candidate = preferred;
      let suffix = 2;
      while (allocated.has(candidate)) {
        candidate = `${preferred}-${suffix}`;
        suffix += 1;
      }
      allocated.add(candidate);
      return candidate;
    },
  };
}

export class RenderError extends Error {
  public constructor(
    message: string,
    public readonly remediation: string,
  ) {
    super(`${message} Fix: ${remediation}`);
    this.name = "RenderError";
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function decodeUtf8(content: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) {
      throw error;
    }
    throw new RenderError(
      `${label} is not valid UTF-8.`,
      "Save the input as valid UTF-8 and render again.",
    );
  }
}

async function readLimitedUtf8(
  absolutePath: string,
  limit: number,
  label: string,
): Promise<string> {
  return decodeUtf8(
    await readLimitedBytes(absolutePath, limit, label),
    label,
  );
}

async function readLimitedBytes(
  absolutePath: string,
  limit: number,
  label: string,
): Promise<Buffer> {
  const handle = await open(absolutePath, "r");
  try {
    const content = Buffer.allocUnsafe(limit + 1);
    let offset = 0;
    while (offset < content.byteLength) {
      const { bytesRead } = await handle.read(
        content,
        offset,
        content.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    if (offset > limit) {
      throw new RenderError(
        `${label} exceeds the ${limit}-byte limit.`,
        "Link large evidence instead of embedding it in the rendered document.",
      );
    }
    return content.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug || "section";
}

async function assertSafeLink(
  caseRoot: string,
  sourcePath: string,
  outputPath: string,
  phaseId: string,
  href: string,
): Promise<string> {
  const trimmed = href.trim();
  if (trimmed.startsWith("#")) {
    let fragment: string;
    try {
      fragment = decodeURIComponent(trimmed.slice(1));
    } catch (error: unknown) {
      if (!(error instanceof URIError)) {
        throw error;
      }
      throw new RenderError(
        `Link "${href}" contains invalid fragment encoding.`,
        "Link to a valid Markdown heading.",
      );
    }
    return fragment.startsWith(`phase-${phaseId}-`)
      ? `#${fragment}`
      : `#phase-${phaseId}-${slugify(fragment)}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    const localPath = trimmed.split(/[?#]/u, 1)[0] ?? "";
    const suffix = trimmed.slice(localPath.length);
    let decoded: string;
    try {
      decoded = decodeURIComponent(localPath);
    } catch (error: unknown) {
      if (!(error instanceof URIError)) {
        throw error;
      }
      throw new RenderError(
        `Link "${href}" contains invalid URL encoding.`,
        "Use a valid case-relative link, HTTPS URL, mailto URL, or page anchor.",
      );
    }
    const caseRelative = path
      .relative(
        caseRoot,
        path.resolve(
          caseRoot,
          path.dirname(sourcePath),
          decoded.replaceAll("/", path.sep),
        ),
      )
      .split(path.sep)
      .join("/");
    const resolved = await resolveContainedCaseFile(
      caseRoot,
      caseRelative,
      "Markdown link",
    );
    if (!resolved.absolutePath) {
      throw new RenderError(
        resolved.error?.message ?? `Link "${href}" is unsafe.`,
        resolved.error?.remediation ??
          "Use a physical case-relative link beneath the case directory.",
      );
    }
    const outputDirectory = path.dirname(
      path.resolve(caseRoot, outputPath.replaceAll("/", path.sep)),
    );
    const rewritten = path
      .relative(outputDirectory, resolved.absolutePath)
      .split(path.sep)
      .join("/");
    return `${rewritten || path.basename(resolved.absolutePath)}${suffix}`;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "mailto:") {
    throw new RenderError(
      `Link "${href}" uses the disallowed ${parsed.protocol || "unknown"} scheme.`,
      "Use HTTPS, mailto, a page anchor, or a contained case-relative link.",
    );
  }
  return trimmed;
}

function walkTokens(
  tokens: Token[],
  visitor: (token: Token) => void,
): void {
  for (const token of tokens) {
    visitor(token);
    if (token.children) {
      walkTokens(token.children, visitor);
    }
  }
}

type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlElement = DefaultTreeAdapterMap["element"];

function isElement(node: HtmlNode): node is HtmlElement {
  return "tagName" in node;
}

const allowedSvgTags = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "title",
  "desc",
]);
const allowedSvgAttributes = new Set([
  "xmlns",
  "viewbox",
  "width",
  "height",
  "role",
  "aria-label",
  "aria-labelledby",
  "id",
  "class",
  "d",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "points",
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-opacity",
  "opacity",
  "transform",
  "font-size",
  "font-family",
  "text-anchor",
]);

function validateSvgNode(node: HtmlNode): void {
  if (isElement(node)) {
    const tag = node.tagName.toLowerCase();
    if (!allowedSvgTags.has(tag)) {
      throw new RenderError(
        `SVG element <${node.tagName}> is not allowed.`,
        "Use a static SVG made only from basic drawing and accessible text elements.",
      );
    }
    for (const attribute of node.attrs) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (
        !allowedSvgAttributes.has(name) ||
        name.startsWith("on") ||
        name === "style" ||
        name.includes("href") ||
        value.includes("url(")
      ) {
        throw new RenderError(
          `SVG attribute "${attribute.name}" is not allowed.`,
          "Remove scripts, styles, event handlers, URL references, and unsupported SVG attributes.",
        );
      }
    }
  }
  if ("childNodes" in node) {
    for (const child of node.childNodes) {
      validateSvgNode(child);
    }
  }
}

function sanitizeSvg(svg: string): string {
  const fragment = parseFragment(svg);
  const roots = fragment.childNodes.filter(isElement);
  if (
    roots.length !== 1 ||
    roots[0]?.tagName.toLowerCase() !== "svg" ||
    fragment.childNodes.some(
      (node) =>
        !isElement(node) &&
        (!("value" in node) || String(node.value).trim() !== ""),
    )
  ) {
    throw new RenderError(
      "SVG input must contain exactly one root <svg> element and no other nodes.",
      "Provide one static SVG document without comments, declarations, or sibling content.",
    );
  }
  for (const node of fragment.childNodes) {
    validateSvgNode(node);
  }
  const cleaned = sanitizeHtml(svg, {
    allowedTags: [...allowedSvgTags],
    allowedAttributes: {
      "*": [...allowedSvgAttributes],
    },
    allowedSchemes: [],
    allowProtocolRelative: false,
    parser: { lowerCaseAttributeNames: true },
  });
  if (!cleaned.trim().startsWith("<svg")) {
    throw new RenderError(
      "SVG input does not contain one safe root <svg> element.",
      "Provide one static SVG document without scripts, styles, or external references.",
    );
  }
  return cleaned;
}

async function embedImage(
  caseRoot: string,
  sourcePath: string,
  imagePath: string,
): Promise<string> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(imagePath);
  } catch (error: unknown) {
    if (!(error instanceof URIError)) {
      throw error;
    }
    throw new RenderError(
      `Image "${imagePath}" contains invalid URL encoding.`,
      "Use a valid contained case-relative asset path.",
    );
  }
  if (
    decoded.includes("?") ||
    decoded.includes("#") ||
    /^[a-z][a-z0-9+.-]*:/iu.test(decoded) ||
    decoded.startsWith("//")
  ) {
    throw new RenderError(
      `Image "${imagePath}" is not a plain local asset path.`,
      "Use a contained case-relative PNG, JPEG, GIF, WebP, or safe static SVG file.",
    );
  }
  const caseRelative = path
    .relative(
      caseRoot,
      path.resolve(caseRoot, path.dirname(sourcePath), decoded),
    )
    .split(path.sep)
    .join("/");
  const resolved = await resolveContainedCaseFile(
    caseRoot,
    caseRelative,
    "Markdown image",
  );
  if (!resolved.absolutePath) {
    throw new RenderError(
      resolved.error?.message ?? "Image path is unsafe.",
      resolved.error?.remediation ?? "Use a physical asset beneath the case directory.",
    );
  }
  const content = await readLimitedBytes(
    resolved.absolutePath,
    MAX_ASSET_BYTES,
    `Image ${imagePath}`,
  );
  const extension = path.extname(resolved.absolutePath).toLowerCase();
  const binaryTypes = new Map([
    [".png", "image/png"],
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".gif", "image/gif"],
    [".webp", "image/webp"],
  ]);
  if (extension === ".svg") {
    const safeSvg = sanitizeSvg(
      decodeUtf8(content, `SVG ${imagePath}`),
    );
    return `data:image/svg+xml;base64,${Buffer.from(safeSvg, "utf8").toString("base64")}`;
  }
  const mediaType = binaryTypes.get(extension);
  if (!mediaType) {
    throw new RenderError(
      `Image type "${extension || "(none)"}" is not allowed.`,
      "Use a PNG, JPEG, GIF, WebP, or safe static SVG asset.",
    );
  }
  return `data:${mediaType};base64,${content.toString("base64")}`;
}

function sanitizeMarkdownFragment(fragment: string): string {
  return sanitizeHtml(fragment, {
    allowedTags: [
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "p",
      "ul",
      "ol",
      "li",
      "blockquote",
      "strong",
      "em",
      "del",
      "a",
      "img",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "pre",
      "code",
      "hr",
      "br",
      "figure",
      "figcaption",
      "aside",
    ],
    allowedAttributes: {
      a: ["href", "rel"],
      img: ["src", "alt", "title", "loading"],
      th: ["scope"],
      h1: ["id"],
      h2: ["id"],
      h3: ["id"],
      h4: ["id"],
      h5: ["id"],
      h6: ["id"],
      figure: ["class", "aria-labelledby"],
      figcaption: ["id"],
      aside: ["class", "role"],
      code: ["class"],
    },
    allowedSchemes: ["https", "mailto", "data"],
    allowedSchemesByTag: {
      img: ["data"],
      a: ["https", "mailto"],
    },
    allowProtocolRelative: false,
  });
}

async function renderMarkdown(
  caseRoot: string,
  sourcePath: string,
  outputPath: string,
  phaseId: string,
  markdown: string,
  requireVisualDiagrams: boolean,
  ids: IdAllocator,
  headingOffset = 0,
): Promise<{ body: string; toc: TocEntry[] }> {
  const engine = new MarkdownIt({
    html: true,
    linkify: false,
    typographer: false,
  });
  engine.validateLink = () => true;
  const tokens = engine.parse(markdown, {});
  const toc: TocEntry[] = [];

  const linkTokens: Token[] = [];
  walkTokens(tokens, (token) => {
    if (token.type === "html_block" || token.type === "html_inline") {
      throw new RenderError(
        "Markdown contains raw HTML, which cannot be rendered faithfully under the default-deny policy.",
        "Replace raw HTML with Markdown or a separately validated local asset.",
      );
    }
    if (token.type === "link_open") {
      linkTokens.push(token);
    }
  });
  for (const token of linkTokens) {
    const href = token.attrGet("href");
    if (href) {
      const safeHref = await assertSafeLink(
        caseRoot,
        sourcePath,
        outputPath,
        phaseId,
        href,
      );
      token.attrSet("href", safeHref);
      if (safeHref.startsWith("https:")) {
        token.attrSet("rel", "noopener noreferrer");
      }
    }
  }

  let previousHeadingDepth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token.type !== "heading_open") {
      continue;
    }
    const sourceDepth = Number(token.tag.slice(1));
    if (
      (previousHeadingDepth === 0 && sourceDepth !== 1) ||
      (previousHeadingDepth > 0 && sourceDepth > previousHeadingDepth + 1)
    ) {
      throw new RenderError(
        `Heading hierarchy jumps to h${sourceDepth}.`,
        "Start with one h1 and increase heading depth one level at a time.",
      );
    }
    previousHeadingDepth = sourceDepth;
    const renderedDepth = sourceDepth + headingOffset;
    if (renderedDepth > 6) {
      throw new RenderError(
        "Heading hierarchy is too deep for the selected rendering context.",
        "Reduce the source heading depth.",
      );
    }
    token.tag = `h${renderedDepth}`;
    const closing = tokens[index + 2];
    if (closing?.type === "heading_close") {
      closing.tag = `h${renderedDepth}`;
    }
    const inline = tokens[index + 1];
    const text = inline?.type === "inline" ? inline.content : "Section";
    const base = `phase-${phaseId}-${slugify(text)}`;
    const id = ids.allocate(base);
    token.attrSet("id", id);
    toc.push({
      depth: renderedDepth,
      id,
      text,
    });
  }
  if (previousHeadingDepth === 0) {
    throw new RenderError(
      "Authoritative Markdown has no semantic heading.",
      "Start the phase document with one h1 heading.",
    );
  }

  const imageTokens: Token[] = [];
  walkTokens(tokens, (token) => {
    if (token.type === "image") {
      imageTokens.push(token);
    }
  });
  for (const token of imageTokens) {
    const src = token.attrGet("src");
    if (!src) {
      throw new RenderError(
        "Markdown image has no source path.",
        "Give every image a contained local source path and descriptive alt text.",
      );
    }
    if (token.content.trim() === "") {
      throw new RenderError(
        `Image "${src}" has empty alternative text.`,
        "Add concise descriptive alt text, or remove a purely decorative image.",
      );
    }
    token.attrSet("src", await embedImage(caseRoot, sourcePath, src));
    token.attrSet("loading", "lazy");
  }

  engine.renderer.rules.th_open = () => '<th scope="col">';
  engine.renderer.rules.code_block = (renderTokens, index) => {
    const token = renderTokens[index];
    const captionId = ids.allocate(
      `phase-${phaseId}-generated-code-${index}`,
    );
    return `<figure class="code-block" aria-labelledby="${captionId}"><figcaption id="${captionId}">Plain text code</figcaption><pre><code>${escapeHtml(token?.content ?? "")}</code></pre></figure>`;
  };
  const defaultFence =
    engine.renderer.rules.fence ??
    ((renderTokens, index, options, _environment, renderer) =>
      renderer.renderToken(renderTokens, index, options));
  engine.renderer.rules.fence = (
    renderTokens,
    index,
    options,
    environment,
    renderer,
  ) => {
    const token = renderTokens[index];
    if (!token) {
      return "";
    }
    const language = token.info.trim().split(/\s+/u, 1)[0] ?? "";
    const label = language || "Plain text";
    const captionId = ids.allocate(
      `phase-${phaseId}-generated-code-${index}`,
    );
    if (language.toLowerCase() === "mermaid") {
      if (requireVisualDiagrams) {
        throw new RenderError(
          "Visual Mermaid completion was requested, but this offline renderer does not execute Mermaid.",
          "Provide a reviewed static SVG asset or render without --require-visual-diagrams.",
        );
      }
      return `<aside class="diagram-warning" role="note">Diagram shown as escaped Mermaid source; no diagram code was executed.</aside><figure class="code-block" aria-labelledby="${captionId}"><figcaption id="${captionId}">Mermaid diagram source</figcaption><pre><code class="language-mermaid">${escapeHtml(token.content)}</code></pre></figure>`;
    }
    const rendered = defaultFence(
      renderTokens,
      index,
      options,
      environment,
      renderer,
    );
    return `<figure class="code-block" aria-labelledby="${captionId}"><figcaption id="${captionId}">${escapeHtml(label)} code</figcaption>${rendered}</figure>`;
  };

  return {
    body: sanitizeMarkdownFragment(engine.renderer.render(tokens, engine.options, {})),
    toc,
  };
}

function renderToc(entries: TocEntry[]): string {
  if (entries.length === 0) {
    return "";
  }
  interface TocNode {
    entry: TocEntry;
    children: TocNode[];
  }
  const roots: TocNode[] = [];
  const stack: TocNode[] = [];
  for (const entry of entries) {
    while (
      stack.length > 0 &&
      (stack.at(-1)?.entry.depth ?? 0) >= entry.depth
    ) {
      stack.pop();
    }
    const node = { entry, children: [] };
    const parent = stack.at(-1);
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
    stack.push(node);
  }
  const renderNodes = (nodes: TocNode[]): string =>
    `<ol>${nodes
      .map(
        ({ entry, children }) =>
          `<li><a href="#${escapeHtml(entry.id)}">${escapeHtml(entry.text)}</a>${children.length > 0 ? renderNodes(children) : ""}</li>`,
      )
      .join("")}</ol>`;
  return `<nav aria-label="Table of contents"><h2>On this page</h2>${renderNodes(roots)}</nav>`;
}

function renderBindings(bindings: SourceBinding[]): string {
  return `<dl class="source-metadata">${bindings
    .map(
      (binding) =>
        `<div><dt>Source</dt><dd><code>${escapeHtml(binding.path)}</code></dd><dt>SHA-256</dt><dd><code>${binding.sha256}</code></dd></div>`,
    )
    .join("")}</dl>`;
}

function renderBindingTable(label: string, bindings: Binding[]): string {
  if (bindings.length === 0) {
    return `<p>${escapeHtml(label)}: none recorded.</p>`;
  }
  return `<h3>${escapeHtml(label)}</h3><table><thead><tr><th scope="col">Path</th><th scope="col">SHA-256</th></tr></thead><tbody>${[...bindings]
    .sort((left, right) => ordinalCompare(left.path, right.path))
    .map(
      ({ path: bindingPath, sha256 }) =>
        `<tr><td><code>${escapeHtml(bindingPath)}</code></td><td><code>${sha256}</code></td></tr>`,
    )
    .join("")}</tbody></table>`;
}

const styles = `
:root{color-scheme:light;--ink:#172033;--muted:#4b5563;--surface:#fff;--soft:#eef2f7;--accent:#174ea6;--border:#cbd5e1}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--surface);color:var(--ink);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:#0645ad;text-underline-offset:.18em}a:focus-visible,button:focus-visible,summary:focus-visible{outline:3px solid #ffbf47;outline-offset:3px}
.skip-link{position:absolute;left:.75rem;top:-5rem;background:#111827;color:#fff;padding:.75rem 1rem;z-index:10}.skip-link:focus{top:.75rem}
header,main,footer{max-width:72rem;margin:auto;padding:1.25rem}header{border-bottom:1px solid var(--border)}main{display:grid;grid-template-columns:minmax(13rem,18rem) minmax(0,1fr);gap:2rem}
nav{align-self:start;position:sticky;top:1rem;grid-column:1;grid-row:1;background:var(--soft);padding:1rem;border-radius:.5rem}nav h2{font-size:1rem;margin-top:0}.toc-depth-3{margin-left:1rem}.toc-depth-4,.toc-depth-5,.toc-depth-6{margin-left:2rem}
article{min-width:0;grid-column:2;grid-row:1}.document-title{font-size:1.8rem;font-weight:700;margin:.25rem 0}h1,h2,h3,h4,h5,h6{line-height:1.25;scroll-margin-top:1rem}table{border-collapse:collapse;width:100%;display:block;overflow-x:auto}th,td{border:1px solid var(--border);padding:.5rem;text-align:left}th{background:var(--soft)}
pre{overflow:auto;background:#111827;color:#f8fafc;padding:1rem;border-radius:.4rem}.code-block figcaption{font-weight:700}.diagram-warning{border-left:.3rem solid #9a6700;background:#fff4ce;padding:.75rem}
.source-metadata{font-size:.9rem;color:var(--muted)}.source-metadata div{border-top:1px solid var(--border);padding:.5rem 0}.source-metadata dt{font-weight:700}.source-metadata dd{margin:0;overflow-wrap:anywhere}
img{max-width:100%;height:auto}footer{border-top:1px solid var(--border);color:var(--muted)}
@media(max-width:48rem){main{grid-template-columns:1fr}nav{position:static}}@media print{.skip-link,nav{display:none}main{display:block}a{color:inherit}body{font-size:11pt}}
`;

export async function renderPhaseHtml(
  options: RenderPhaseOptions,
): Promise<void> {
  const source = await resolveContainedCaseFile(
    options.caseRoot,
    options.sourcePath,
    "Authoritative Markdown source",
  );
  if (!source.absolutePath) {
    throw new RenderError(
      source.error?.message ?? "Source path is unsafe.",
      source.error?.remediation ?? "Use a physical Markdown file beneath the case directory.",
    );
  }
  if (path.extname(source.absolutePath).toLowerCase() !== ".md") {
    throw new RenderError(
      "Authoritative phase source must be Markdown.",
      "Pass the phase .md file as --source.",
    );
  }
  const output = await resolveContainedOutputPath(
    options.caseRoot,
    options.outputPath,
  );
  if (!output.absolutePath) {
    throw new RenderError(
      output.error?.message ?? "Output path is unsafe.",
      output.error?.remediation ?? "Write HTML beneath the case directory.",
    );
  }
  if (path.extname(output.absolutePath).toLowerCase() !== ".html") {
    throw new RenderError(
      "Renderer output must use the .html extension.",
      "Choose the contracted phase HTML filename.",
    );
  }
  const phaseFolder = phaseFolders[options.phaseId];
  const normalizedSource = options.sourcePath.split(path.sep).join("/");
  const normalizedOutput = options.outputPath.split(path.sep).join("/");
  const expectedOutput = normalizedSource.replace(/\.md$/u, ".html");
  if (
    !phaseFolder ||
    !normalizedSource.startsWith(`${phaseFolder}/`) ||
    normalizedOutput !== expectedOutput
  ) {
    throw new RenderError(
      "Phase source and output do not use the contracted lifecycle folder and matching basename.",
      "Write <phase-folder>/<artifactPrefix>-<artifact>.html beside its authoritative Markdown.",
    );
  }

  const markdownBytes = await readLimitedBytes(
    source.absolutePath,
    MAX_MARKDOWN_BYTES,
    options.sourcePath,
  );
  const markdown = decodeUtf8(markdownBytes, options.sourcePath);
  const bindings: SourceBinding[] = [
    {
      path: options.sourcePath.split(path.sep).join("/"),
      sha256: hashArtifactBytes(source.absolutePath, markdownBytes),
    },
  ];
  const metadataRecords: LoadedRecord[] = [];
  const repositoryRoot = path.resolve(options.caseRoot, "..", "..");
  const registry = await createSchemaRegistry(repositoryRoot);
  if (registry.errors.length > 0) {
    throw new RenderError(
      registry.errors[0]?.message ?? "Schema registry validation failed.",
      registry.errors[0]?.remediation ?? "Restore the versioned AFF schema catalogue.",
    );
  }
  const metadataPaths =
    options.metadataPaths.length > 0
      ? [...options.metadataPaths].sort()
      : (await readdir(path.dirname(source.absolutePath)))
          .filter((file) => file.endsWith(".json") &&
            isCataloguedRecordPath(registry, `${phaseFolder}/${file}`))
          .sort()
          .map((file) => `${phaseFolder}/${file}`);
  if (metadataPaths.length === 0) {
    throw new RenderError(
      "Phase rendering requires at least one authoritative structured metadata record.",
      "Create the phase catalogue or Phase 0 inventory/model plan and pass it with --metadata.",
    );
  }
  for (const metadataPath of metadataPaths) {
    const metadata = await resolveContainedCaseFile(
      options.caseRoot,
      metadataPath,
      "Renderer metadata",
    );
    if (!metadata.absolutePath) {
      throw new RenderError(
        metadata.error?.message ?? "Metadata path is unsafe.",
        metadata.error?.remediation ?? "Use a physical metadata file beneath the case directory.",
      );
    }
    const metadataBytes = await readLimitedBytes(
      metadata.absolutePath,
      MAX_METADATA_BYTES,
      metadataPath,
    );
    const metadataContent = decodeUtf8(metadataBytes, metadataPath);
    let metadataValue: unknown;
    try {
      metadataValue = JSON.parse(metadataContent);
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
      throw new RenderError(
        `Renderer metadata "${metadataPath}" is not valid JSON: ${error.message}`,
        "Correct the structured metadata before rendering.",
      );
    }
    if (!isRecord(metadataValue)) {
      throw new RenderError(
        `Renderer metadata "${metadataPath}" must contain a JSON object.`,
        "Pass an authoritative AFF structured record.",
      );
    }
    const recordType =
      typeof metadataValue.recordType === "string"
        ? metadataValue.recordType
        : undefined;
    if (!recordType) {
      throw new RenderError(
        `Renderer metadata "${metadataPath}" has no recordType.`,
        "Pass an authoritative AFF structured record validated by the schema catalogue.",
      );
    }
    const schemaErrors = validateRecordSchema(
      registry,
      metadataPath,
      metadataValue,
      recordType,
    );
    if (schemaErrors.length > 0) {
      throw new RenderError(
        schemaErrors[0]?.message ?? `Renderer metadata "${metadataPath}" is invalid.`,
        schemaErrors[0]?.remediation ?? "Correct the structured AFF record.",
      );
    }
    metadataRecords.push({
      file: metadataPath.split(path.sep).join("/"),
      absolutePath: metadata.absolutePath,
      snapshotSha256: hashArtifactBytes(metadata.absolutePath, metadataBytes),
      value: metadataValue,
    });
    bindings.push({
      path: metadataPath.split(path.sep).join("/"),
      sha256: hashArtifactBytes(metadata.absolutePath, metadataBytes),
    });
  }
  const identityRecords = options.phaseId === "0"
    ? metadataRecords
    : [
        ...(await readIdentityAnchors(registry, options.caseRoot))
          .filter(({ file }) => !metadataRecords.some((record) => record.file === file)),
        ...metadataRecords,
      ];
  // Phase metadata may exist before a model plan, journal, reviews, or approval.
  // Check the supplied contract without imposing the completed-case gates.
  if (new Set(identityRecords.map(({ value }) => value.schemaVersion)).size > 1) {
    throw new RenderError(
      "Renderer metadata mixes AFF record schema versions.",
      "Use the case's original contract version for every metadata record.",
    );
  }
  if (identityRecords.some(({ value }) => value.recordType === "model-plan")) {
    const policy = resolveCasePolicy(identityRecords);
    if (policy.errors.length > 0) {
      throw new RenderError(
        policy.errors[0]!.message,
        policy.errors[0]!.remediation,
      );
    }
  }
  const metadataHashErrors = await validateHashBindings(
    options.caseRoot,
    metadataRecords,
  );
  if (metadataHashErrors.length > 0) {
    const first = metadataHashErrors[0];
    throw new RenderError(
      first?.message ?? "Renderer metadata has an invalid artifact binding.",
      first?.remediation ?? "Refresh the structured metadata hashes.",
    );
  }
  const identityErrors = validateRecordIdentity(
    options.caseRoot,
    identityRecords,
  );
  if (identityErrors.length > 0) {
    throw new RenderError(
      identityErrors[0]?.message ?? "Renderer metadata identity is invalid.",
      identityErrors[0]?.remediation ??
        "Use the case name and artifact prefix consistently.",
    );
  }
  const artifactPrefix =
    typeof metadataRecords[0]?.value.artifactPrefix === "string"
      ? metadataRecords[0].value.artifactPrefix
      : undefined;
  const primaryMarkdownName = phaseArtifactNames[options.phaseId]?.find((name) =>
    name.endsWith(".md"),
  );
  if (
    !artifactPrefix ||
    !primaryMarkdownName ||
    normalizedSource !==
      `${phaseFolder}/${artifactPrefix}-${primaryMarkdownName}` ||
    normalizedOutput !==
      `${phaseFolder}/${artifactPrefix}-${primaryMarkdownName.replace(/\.md$/u, ".html")}`
  ) {
    throw new RenderError(
      "Phase source and output do not match the contracted artifact prefix and primary phase document name.",
      "Use <phase-folder>/<artifactPrefix>-<phase-artifact>.md and its matching .html filename.",
    );
  }
  const ids = createIdAllocator();
  const mainContentId = ids.allocate("main-content");
  const rendered = await renderMarkdown(
    options.caseRoot,
    options.sourcePath,
    options.outputPath,
    options.phaseId,
    markdown,
    options.requireVisualDiagrams ?? false,
    ids,
  );
  const title = rendered.toc[0]?.text ?? `AFF Phase ${options.phaseId}`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">${contentSecurityPolicyMeta(false)}<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="generator" content="aff-render"><meta name="aff-source-sha256" content="${bindings[0]?.sha256 ?? ""}"><title>${escapeHtml(title)}</title><style>${styles}</style></head>
<body><a class="skip-link" href="#${mainContentId}">Skip to main content</a><header><p>AFF generated view</p><p class="document-title">${escapeHtml(title)}</p>${renderBindings(bindings)}<p>This is generated phase evidence. It carries no approval of its own; approval state and assurance are recorded in <code>solution-overview.html</code>.</p></header>
<main id="${mainContentId}"><article aria-label="${escapeHtml(title)}">${rendered.body}</article>${renderToc(rendered.toc)}</main>
<footer>Generated from authoritative case sources. Markdown and structured records remain authoritative.</footer></body></html>
`;
  if (Buffer.byteLength(html, "utf8") > MAX_OUTPUT_BYTES) {
    throw new RenderError(
      `Rendered HTML exceeds the ${MAX_OUTPUT_BYTES}-byte output limit.`,
      "Link large evidence instead of embedding it.",
    );
  }
  await writeFileAtomic(output.absolutePath, html, {
    encoding: "utf8",
    fsync: true,
  });
}

async function readRenderRecord(
  registry: SchemaRegistry,
  caseRoot: string,
  file: string,
  recordType: string,
): Promise<LoadedRecord> {
  const resolved = await resolveContainedCaseFile(caseRoot, file, "Renderer metadata");
  if (!resolved.absolutePath) {
    throw new RenderError(
      resolved.error!.message,
      resolved.error!.remediation,
    );
  }
  const bytes = await readLimitedBytes(resolved.absolutePath, MAX_METADATA_BYTES, file);
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8(bytes, file));
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    throw new RenderError(
      `Renderer metadata "${file}" is not valid JSON: ${error.message}`,
      "Correct the authoritative JSON before rendering.",
    );
  }
  const errors = validateRecordSchema(registry, file, value, recordType);
  if (errors.length > 0 || !isRecord(value)) {
    throw new RenderError(
      errors[0]?.message ?? `Renderer metadata "${file}" must be an AFF object.`,
      errors[0]?.remediation ?? "Supply the contracted authoritative record.",
    );
  }
  return {
    file,
    absolutePath: resolved.absolutePath,
    snapshotSha256: hashArtifactBytes(resolved.absolutePath, bytes),
    value,
  };
}

async function readIdentityAnchors(
  registry: SchemaRegistry,
  caseRoot: string,
): Promise<LoadedRecord[]> {
  let files: string[];
  try {
    files = await readdir(path.join(caseRoot, "0-coordination"));
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const records: LoadedRecord[] = [];
  for (const file of files.sort()) {
    const recordType = file.endsWith("-model-plan.json") ? "model-plan"
      : file.endsWith("-input-inventory.json") ? "input-inventory" : undefined;
    if (recordType) {
      records.push(await readRenderRecord(registry, caseRoot, `0-coordination/${file}`, recordType));
    }
  }
  return records;
}

export async function renderReviewHtml(options: RenderReviewOptions): Promise<void> {
  const resolved = await resolveCasePath(options.repositoryRoot, options.casePath);
  if (!resolved.caseRoot) {
    throw new RenderError(resolved.errors[0]!.message, resolved.errors[0]!.remediation);
  }
  const caseRoot = resolved.caseRoot;
  const registry = await createSchemaRegistry(options.repositoryRoot);
  if (registry.errors.length > 0) {
    throw new RenderError(registry.errors[0]!.message, registry.errors[0]!.remediation);
  }
  const sourcePath = options.sourcePath.split(path.sep).join("/");
  const metadataPath = options.metadataPath.split(path.sep).join("/");
  const outputPath = options.outputPath.split(path.sep).join("/");
  const record = await readRenderRecord(registry, caseRoot, metadataPath, "review-record");
  const review = asReview(record);
  const prefix = record.value.artifactPrefix;
  const basename = `reviews/${options.reviewer.toLowerCase()}/${options.phaseId}/round-${options.round}/${String(prefix)}-${options.reviewer.toLowerCase()}-review`;
  if (
    !review ||
    !Number.isSafeInteger(options.round) ||
    !phaseFolders[options.phaseId] ||
    review.reviewer !== options.reviewer ||
    review.phaseId !== options.phaseId ||
    review.round !== options.round ||
    sourcePath !== `${basename}.md` ||
    metadataPath !== `${basename}.json` ||
    outputPath !== `${basename}.html`
  ) {
    throw new RenderError(
      "Review source, metadata and output must match the contracted reviewer, phase, round, prefix and basename.",
      "Use reviews/<aff-a|aff-b>/<phase-id>/round-<n>/<artifactPrefix>-<aff-a|aff-b>-review.{md,json,html}.",
    );
  }
  const source = await resolveContainedCaseFile(caseRoot, sourcePath, "Authoritative review Markdown");
  const output = await resolveContainedOutputPath(caseRoot, outputPath);
  if (!source.absolutePath || !output.absolutePath) {
    const error = source.error ?? output.error!;
    throw new RenderError(error.message, error.remediation);
  }
  const plan = await readRenderRecord(
    registry, caseRoot, `0-coordination/${String(prefix)}-model-plan.json`, "model-plan",
  );
  const anchors = await readIdentityAnchors(registry, caseRoot);
  const records = [plan, ...anchors.filter(({ file }) => file !== plan.file), record];
  const policy = resolveCasePolicy(records);
  if (!policy.policy) {
    throw new RenderError(policy.errors[0]!.message, policy.errors[0]!.remediation);
  }
  const lifecycle = await readLifecycle(options.repositoryRoot);
  const defaults = await readHostModelDefaults(options.repositoryRoot, policy.policy.host, lifecycle);
  const errors = [
    ...defaults.errors,
    ...validateRecordIdentity(caseRoot, records),
    ...validateModelProviders(records, policy.policy.host),
    ...validateModelPlans(records, lifecycle, defaults.models),
    ...validateReviewModels(records, lifecycle, defaults.models),
  ];
  if (errors.length > 0) {
    throw new RenderError(errors[0]!.message, errors[0]!.remediation);
  }
  if (review.subjectArtifacts.some(({ path: file }) =>
    [sourcePath, metadataPath, outputPath].includes(file.split(path.sep).join("/")))) {
    throw new RenderError(
      "A review cannot bind its own Markdown, JSON or generated HTML as a subject artifact.",
      "Bind the phase candidate; render the review afterwards without a circular review hash.",
    );
  }
  const hashErrors = await validateHashBindings(caseRoot, records);
  if (hashErrors.length > 0) {
    throw new RenderError(hashErrors[0]!.message, hashErrors[0]!.remediation);
  }
  const bytes = await readLimitedBytes(source.absolutePath, MAX_MARKDOWN_BYTES, sourcePath);
  const markdown = decodeUtf8(bytes, sourcePath);
  const bindings: SourceBinding[] = [
    { path: sourcePath, sha256: hashArtifactBytes(source.absolutePath, bytes) },
    { path: metadataPath, sha256: record.snapshotSha256 },
    { path: plan.file, sha256: plan.snapshotSha256 },
  ];
  const ids = createIdAllocator();
  const mainContentId = ids.allocate("main-content");
  const rendered = await renderMarkdown(
    caseRoot, sourcePath, outputPath, options.phaseId, markdown,
    options.requireVisualDiagrams ?? false, ids,
  );
  const title = `${review.reviewer} — Phase ${review.phaseId} — Round ${review.round}`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">${contentSecurityPolicyMeta(false)}<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="generator" content="aff-render"><meta name="aff-source-sha256" content="${bindings[0]!.sha256}"><title>${escapeHtml(title)}</title><style>${styles}</style></head>
<body><a class="skip-link" href="#${mainContentId}">Skip to main content</a><header><p>AFF generated review view</p><p class="document-title">${escapeHtml(title)}</p>${renderBindings(bindings)}<p>Reviewer verdict: ${escapeHtml(review.verdict)}. Final: ${review.final ? "yes" : "no"}. This generated view is not human approval or proof of reviewer convergence.</p></header>
<main id="${mainContentId}"><article aria-label="${escapeHtml(title)}">${rendered.body}<details><summary>Authoritative structured review record</summary><pre><code>${escapeHtml(JSON.stringify(record.value, null, 2))}</code></pre></details></article>${renderToc(rendered.toc)}</main>
<footer>Generated from authoritative review Markdown and JSON, without changing either source.</footer></body></html>
`;
  if (Buffer.byteLength(html, "utf8") > MAX_OUTPUT_BYTES) {
    throw new RenderError(
      `Rendered HTML exceeds the ${MAX_OUTPUT_BYTES}-byte output limit.`,
      "Link large evidence instead of embedding it.",
    );
  }
  await writeFileAtomic(output.absolutePath, html, { encoding: "utf8", fsync: true });
}

function journalEvents(records: LoadedRecord[]): LoadedRecord[] {
  return records
    .filter(({ value }) => value.recordType === "run-journal-event")
    .sort((left, right) => {
      const leftSequence =
        typeof left.value.sequence === "number" ? left.value.sequence : 0;
      const rightSequence =
        typeof right.value.sequence === "number" ? right.value.sequence : 0;
      return leftSequence - rightSequence;
    });
}

function eventBindings(
  event: LoadedRecord | undefined,
  field: "artifactHashes" | "reviewHashes",
): Binding[] {
  const value = event?.value[field];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (binding): binding is Binding =>
      isRecord(binding) &&
      typeof binding.path === "string" &&
      typeof binding.sha256 === "string",
  );
}

function phaseState(
  phaseEvents: LoadedRecord[],
  approval: Approval | undefined,
): string {
  const latestEvent = phaseEvents.at(-1);
  if (!latestEvent) {
    return "Not invoked";
  }
  if (latestEvent.value.eventType === "PHASE-REOPENED") {
    return "Reopened";
  }
  if (latestEvent.value.eventType === "BLOCKER") {
    return "Blocked";
  }
  if (latestEvent.value.eventType === "PHASE-ENTERED") {
    return "In progress";
  }
  let invalidatedAt = -1;
  let approvedAt = -1;
  for (const [index, event] of phaseEvents.entries()) {
    if (
      event.value.eventType === "PHASE-REOPENED" ||
      event.value.eventType === "BLOCKER" ||
      event.value.eventType === "ARTIFACTS-RECORDED"
    ) {
      invalidatedAt = index;
    }
    if (
      event.value.eventType === "HUMAN-DECISION" &&
      event.value.decision === "APPROVED" &&
      approval?.decision === "APPROVED" &&
      bindingSet(eventBindings(event, "artifactHashes")) ===
        bindingSet(approval.artifactHashes) &&
      bindingSet(eventBindings(event, "reviewHashes")) ===
        bindingSet(approval.reviewRecords)
    ) {
      approvedAt = index;
    }
  }
  const activeApproval = approvedAt > invalidatedAt;
  const journalApproved =
    activeApproval && approval?.decision === "APPROVED";
  if (
    latestEvent.value.eventType === "PHASE-EXITED" &&
    journalApproved
  ) {
    return approval.syntheticTestEvidence
      ? "Synthetic test approval and exited"
      : "Approved and exited";
  }
  if (
    latestEvent.value.eventType === "HUMAN-DECISION" &&
    latestEvent.value.decision === "APPROVED" &&
    journalApproved
  ) {
    return approval.syntheticTestEvidence ? "Synthetic test approval" : "Approved";
  }
  if (
    latestEvent.value.eventType === "HUMAN-DECISION" &&
    latestEvent.value.decision === "REJECTED"
  ) {
    return "Rejected";
  }
  const eventType =
    typeof latestEvent.value.eventType === "string"
      ? latestEvent.value.eventType
      : "UNKNOWN";
  return `Not approved (${eventType})`;
}

function renderReviewPanel(
  reviewer: "AFF-A" | "AFF-B",
  displayName: string,
  reviews: Review[],
  hashes: Map<string, string>,
): string {
  const title = `${displayName} (${reviewer}) review`;
  if (reviews.length === 0) {
    return `<section><h2>${title}</h2><p>No validated ${reviewer} review record was invoked.</p></section>`;
  }
  return `<section><h2>${title}</h2>${reviews
    .sort((left, right) => {
      const phaseComparison =
        left.phaseId < right.phaseId
          ? -1
          : left.phaseId > right.phaseId
            ? 1
            : 0;
      return phaseComparison === 0 ? left.round - right.round : phaseComparison;
    })
    .map(
      (review) =>
        `<article><h3>Phase ${escapeHtml(review.phaseId)}, round ${review.round}</h3><dl><dt>Model</dt><dd><code>${escapeHtml(review.model)}</code></dd><dt>Verdict</dt><dd>${escapeHtml(review.verdict)}</dd><dt>Final</dt><dd>${review.final ? "Yes" : "No"}</dd><dt>Review record SHA-256</dt><dd><code>${hashes.get(review.file) ?? "Unavailable"}</code></dd></dl>${renderBindingTable("Reviewed artifact hashes", review.subjectArtifacts)}</article>`,
    )
    .join("")}</section>`;
}

function tabButton(
  tabId: string,
  panelId: string,
  label: string,
  selected: boolean,
): string {
  return `<button type="button" role="tab" id="${tabId}" aria-controls="${panelId}" aria-selected="${selected ? "true" : "false"}" tabindex="${selected ? "0" : "-1"}">${escapeHtml(label)}</button>`;
}

function tabPanel(
  tabId: string,
  panelId: string,
  content: string,
  selected: boolean,
): string {
  return `<section role="tabpanel" id="${panelId}" aria-labelledby="${tabId}"${selected ? "" : " hidden"}>${content}</section>`;
}

const tabScript = `<script>
(()=>{const list=document.querySelector('[role="tablist"]');if(!list)return;const tabs=[...list.querySelectorAll('[role="tab"]')];const activate=(tab)=>{for(const item of tabs){const selected=item===tab;item.setAttribute('aria-selected',String(selected));item.tabIndex=selected?0:-1;const panel=document.getElementById(item.getAttribute('aria-controls'));if(panel)panel.hidden=!selected;}tab.focus();};list.addEventListener('click',(event)=>{const tab=event.target.closest('[role="tab"]');if(tab)activate(tab);});list.addEventListener('keydown',(event)=>{const current=tabs.indexOf(document.activeElement);if(current<0)return;let next=current;if(event.key==='ArrowRight')next=(current+1)%tabs.length;else if(event.key==='ArrowLeft')next=(current-1+tabs.length)%tabs.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=tabs.length-1;else return;event.preventDefault();activate(tabs[next]);});})();
</script>`;

export async function renderSolutionOverview(
  options: RenderOverviewOptions,
): Promise<void> {
  const resolved = await resolveCasePath(
    options.repositoryRoot,
    options.casePath,
  );
  if (!resolved.caseRoot) {
    const first = resolved.errors[0];
    throw new RenderError(
      first?.message ?? "Case path is invalid.",
      first?.remediation ?? "Use cases/<case-name>.",
    );
  }
  const caseRoot = resolved.caseRoot;
  const loaded = await loadCaseRecords(options.repositoryRoot, caseRoot);
  const validation = await validateLoadedCase(
    options.repositoryRoot,
    caseRoot,
    loaded,
  );
  if (validation.errors.length > 0) {
    const first = validation.errors[0];
    throw new RenderError(
      `Case validation failed: ${first?.message ?? "unknown validation error"}`,
      first?.remediation ?? "Run aff-validate and correct every reported error.",
    );
  }

  const lifecycle = await readLifecycle(options.repositoryRoot);
  const events = journalEvents(loaded.records);
  if (events.length === 0) {
    throw new RenderError(
      "The case has no validated run-journal events.",
      "Record explicit phase events before generating the cumulative overview.",
    );
  }
  const latestEvents = new Map<string, LoadedRecord>();
  const decisionEvents = new Map<string, LoadedRecord>();
  const phaseOwners = new Map(
    lifecycle.phases.map(({ id, owner }) => [id, owner]),
  );
  for (const event of events) {
    const phaseId = event.value.phaseId;
    if (typeof phaseId !== "string") {
      continue;
    }
    if (
      [
        "PHASE-ENTERED",
        "ARTIFACTS-RECORDED",
        "BLOCKER",
        "PHASE-REOPENED",
        "PHASE-EXITED",
      ].includes(String(event.value.eventType)) &&
      event.value.actor !== phaseOwners.get(phaseId)
    ) {
      throw new RenderError(
        `Journal event ${String(event.value.eventId)} for phase ${phaseId} is not owned by ${phaseOwners.get(phaseId) ?? "the lifecycle phase owner"}.`,
        "Record phase lifecycle events with the declared phase owner.",
      );
    }
    latestEvents.set(phaseId, event);
    if (event.value.eventType === "HUMAN-DECISION") {
      decisionEvents.set(phaseId, event);
    }
  }
  const approvals = new Map<string, Approval>();
  for (const record of loaded.records) {
    const approval = asApproval(record);
    if (!approval) {
      continue;
    }
    const current = approvals.get(approval.phaseId);
    if (
      !current ||
      Date.parse(approval.decidedAt) > Date.parse(current.decidedAt)
    ) {
      approvals.set(approval.phaseId, approval);
    }
  }
  for (const [phaseId, approval] of approvals) {
    const decision = decisionEvents.get(phaseId);
    if (
      !decision ||
      decision.value.decision !== approval.decision ||
      decision.value.actor !== approval.approver ||
      typeof decision.value.timestamp !== "string" ||
      Date.parse(decision.value.timestamp) !== Date.parse(approval.decidedAt)
    ) {
      throw new RenderError(
        `Phase ${phaseId} approval is not represented by a matching actor, time, and decision in the validated HUMAN-DECISION journal event.`,
        "Append a journal decision event bound to the approval actor, decision time, artifact hashes, and review hashes.",
      );
    }
    if (
      bindingSet(eventBindings(decision, "artifactHashes")) !==
        bindingSet(approval.artifactHashes) ||
      bindingSet(eventBindings(decision, "reviewHashes")) !==
        bindingSet(approval.reviewRecords)
    ) {
      throw new RenderError(
        `Phase ${phaseId} journal decision hashes do not match the human approval record.`,
        "Append a corrected decision event; do not infer approval from mismatched evidence.",
      );
    }
  }
  if (
    ![...approvals.values()].some(
      (approval) => approval.decision === "APPROVED",
    )
  ) {
    throw new RenderError(
      "A cumulative overview requires at least one validated human approval.",
      "Complete converged reviews, record the human decision, and append the matching journal event.",
    );
  }

  const candidates = latestCandidateEvents(loaded.records);
  const ids = createIdAllocator();
  const mainContentId = ids.allocate("main-content");
  const reviewHashByFile = new Map<string, string>();
  const loadedRecordHashByFile = new Map(
    loaded.records.map((record) => [
      record.file,
      record.snapshotSha256,
    ]),
  );
  for (const review of allReviews(loaded.records)) {
    const reviewHash = loadedRecordHashByFile.get(review.file);
    if (reviewHash) {
      reviewHashByFile.set(review.file, reviewHash);
    }
  }
  const tabs: Array<{ id: string; label: string; content: string }> = [];
  for (const phase of lifecycle.phases) {
    const latestEvent = latestEvents.get(phase.id);
    if (!latestEvent) {
      continue;
    }
    const approval = approvals.get(phase.id);
    const candidate = candidates.get(phase.id);
    const primaryMarkdownName = phaseArtifactNames[phase.id]?.find((name) =>
      name.endsWith(".md"),
    );
    const expectedMarkdownPath =
      candidate && primaryMarkdownName
        ? `${phase.folder}/${candidate.artifactPrefix}-${primaryMarkdownName}`
        : undefined;
    const markdownBinding = (
      approval?.decision === "APPROVED"
        ? approval.artifactHashes
        : candidate?.artifacts
    )?.find((binding) => binding.path === expectedMarkdownPath);
    let phaseContent =
      "<p>No candidate Markdown has been journalled for this invoked phase.</p>";
    if (markdownBinding) {
      const markdownFile = await resolveContainedCaseFile(
        caseRoot,
        markdownBinding.path,
        `Phase ${phase.id} Markdown`,
      );
      if (!markdownFile.absolutePath) {
        throw new RenderError(
          markdownFile.error?.message ?? "Phase Markdown is unsafe.",
          markdownFile.error?.remediation ?? "Restore the governed phase Markdown.",
        );
      }
      const markdownBytes = await readLimitedBytes(
        markdownFile.absolutePath,
        MAX_MARKDOWN_BYTES,
        markdownBinding.path,
      );
      const actualMarkdownHash = hashArtifactBytes(
        markdownFile.absolutePath,
        markdownBytes,
      );
      if (actualMarkdownHash !== markdownBinding.sha256) {
        throw new RenderError(
          `Phase ${phase.id} Markdown changed after case validation: SHA-256 ${actualMarkdownHash}, expected ${markdownBinding.sha256}.`,
          "Do not render changed evidence; record a new candidate, reviews, and approval where required.",
        );
      }
      const markdown = decodeUtf8(markdownBytes, markdownBinding.path);
      phaseContent = (
        await renderMarkdown(
          caseRoot,
          markdownBinding.path,
          "solution-overview.html",
          phase.id,
          markdown,
          false,
          ids,
          1,
        )
      ).body;
    }
    const approvalHash = approval
      ? loadedRecordHashByFile.get(approval.file)
      : undefined;
    const phaseEvents = events.filter(
      (event) => event.value.phaseId === phase.id,
    );
    const state = phaseState(phaseEvents, approval);
    tabs.push({
      id: `phase-${phase.id}`,
      label: phase.displayName,
      content: `<article>${phaseContent}<section aria-label="Phase state and evidence"><h2>Phase state and evidence</h2><p><strong>Journal-derived state:</strong> ${escapeHtml(state)}</p>${approval ? `<p><strong>Approval assurance:</strong> ${escapeHtml(approvalModeLabel(resolveApprovalMode(approval)))}</p>` : ""}<p><strong>Latest event:</strong> ${escapeHtml(String(latestEvent.value.eventType))} - ${escapeHtml(String(latestEvent.value.summary))}</p>${renderBindingTable("Artifact hashes", approval?.artifactHashes ?? candidate?.artifacts ?? [])}${approvalHash ? `<h3>Approval evidence</h3><p>Approval record: <code>${escapeHtml(approval?.file ?? "")}</code></p><p>Approval record SHA-256: <code>${approvalHash}</code></p>${renderBindingTable("Review record hashes", approval?.reviewRecords ?? [])}` : "<p>No validated human approval is recorded.</p>"}</section></article>`,
    });
  }
  const reviews = latestReviews(loaded.records);
  tabs.push({
    id: "aff-a",
    label: "Rubber Duck Reviewer",
    content: renderReviewPanel(
      "AFF-A",
      lifecycle.reviewers.find(({ id }) => id === "AFF-A")?.displayName ??
        "Rubber Duck Reviewer",
      [...reviews.values()].filter(({ reviewer }) => reviewer === "AFF-A"),
      reviewHashByFile,
    ),
  });
  tabs.push({
    id: "aff-b",
    label: "Security and Compliance Reviewer",
    content: renderReviewPanel(
      "AFF-B",
      lifecycle.reviewers.find(({ id }) => id === "AFF-B")?.displayName ??
        "Security and Compliance Reviewer",
      [...reviews.values()].filter(({ reviewer }) => reviewer === "AFF-B"),
      reviewHashByFile,
    ),
  });

  const outputPath = options.outputPath ?? "solution-overview.html";
  if (outputPath.split(path.sep).join("/") !== "solution-overview.html") {
    throw new RenderError(
      "Cumulative overview output must be the contracted case-root solution-overview.html.",
      "Remove the custom output path.",
    );
  }
  const output = await resolveContainedOutputPath(caseRoot, outputPath);
  if (!output.absolutePath) {
    throw new RenderError(
      output.error?.message ?? "Overview output path is unsafe.",
      output.error?.remediation ?? "Write solution-overview.html at the case root.",
    );
  }
  const allocatedTabs = tabs.map((tab) => ({
    ...tab,
    tabId: ids.allocate(`generated-tab-${tab.id}`),
    panelId: ids.allocate(`generated-panel-${tab.id}`),
  }));
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">${contentSecurityPolicyMeta(true)}<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="generator" content="aff-render"><title>AFF solution overview</title><style>${styles}
.tabs [role="tablist"]{display:flex;flex-wrap:wrap;gap:.5rem;border-bottom:1px solid var(--border);padding-bottom:.5rem}.tabs [role="tab"]{border:1px solid var(--border);background:var(--soft);color:var(--ink);padding:.65rem .9rem;border-radius:.35rem;cursor:pointer}.tabs [role="tab"][aria-selected="true"]{background:var(--accent);color:#fff}.tabs [role="tabpanel"]{padding-top:1rem}.tabs [hidden]{display:none}main.overview{display:block}
</style></head><body><a class="skip-link" href="#${mainContentId}">Skip to main content</a><header><p>AFF generated cumulative view</p><h1>Solution overview</h1><p>States come only from validated journal events. Missing evidence never implies success.</p></header><main class="overview" id="${mainContentId}"><div class="tabs"><div role="tablist" aria-label="Case phases and independent reviews">${allocatedTabs.map((tab, index) => tabButton(tab.tabId, tab.panelId, tab.label, index === 0)).join("")}</div>${allocatedTabs.map((tab, index) => tabPanel(tab.tabId, tab.panelId, tab.content, index === 0)).join("")}</div></main><footer>Generated from validated case records. Authoritative Markdown, catalogues, journal events, reviews, and approvals remain separate.</footer>${tabScript}</body></html>
`;
  if (Buffer.byteLength(html, "utf8") > MAX_OUTPUT_BYTES) {
    throw new RenderError(
      `Rendered overview exceeds the ${MAX_OUTPUT_BYTES}-byte output limit.`,
      "Link large evidence and code instead of embedding it.",
    );
  }
  await writeFileAtomic(output.absolutePath, html, {
    encoding: "utf8",
    fsync: true,
  });
}
