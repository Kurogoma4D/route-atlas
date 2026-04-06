/**
 * Pure function to convert AnalysisResult to Cytoscape.js elements.
 *
 * Handles:
 * - Screen nodes with labels and variant badges
 * - Compound parent nodes for shared path prefixes (grouped routes)
 * - Directed edges with method-based styling
 *
 * Reference: SPEC.md §7.2
 */

import type { ElementDefinition } from "cytoscape";
import type { AnalysisResult, Screen } from "@route-atlas/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Transition method category used to determine edge line style. */
export type TransitionMethod = "link" | "programmatic" | "redirect";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Classify a transition's `method` string into one of the three categories.
 * The method string from LLM analysis can be free-form, so we use keyword matching.
 */
export function classifyMethod(method: string): TransitionMethod {
  const lower = method.toLowerCase();

  // Redirect-style navigation (check before "link" so "redirect" isn't misclassified)
  if (
    lower.includes("redirect") ||
    lower.includes("window.location") ||
    lower === "redirect"
  ) {
    return "redirect";
  }

  // Link-style navigation (handles "routerLink", <a>, href, etc.)
  if (
    lower.includes("link") ||
    lower.includes("<a") ||
    lower.includes("href")
  ) {
    return "link";
  }

  if (
    lower.includes("router") ||
    lower.includes("navigate") ||
    lower.includes("push") ||
    lower.includes("programmatic") ||
    lower.includes("usenavigat")
  ) {
    return "programmatic";
  }

  // Default: treat as link
  return "link";
}

/**
 * Derive parent group ID from a screen path.
 * For paths like "/dashboard/settings", the parent is "/dashboard".
 * Top-level paths (e.g., "/" or "/login") return null (no parent group).
 */
export function deriveParentPath(path: string): string | null {
  // Normalize: remove trailing slash
  const normalized = path.replace(/\/+$/, "") || "/";
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length <= 1) {
    return null;
  }
  return "/" + segments.slice(0, -1).join("/");
}

/**
 * Collect all unique parent paths from a list of screens.
 * Returns a set of paths that should become compound (parent) nodes.
 */
function collectParentPaths(screens: Screen[]): Set<string> {
  const parents = new Set<string>();
  for (const screen of screens) {
    const parent = deriveParentPath(screen.path);
    if (parent !== null) {
      parents.add(parent);
    }
  }
  return parents;
}

// ---------------------------------------------------------------------------
// Main converter
// ---------------------------------------------------------------------------

/**
 * Convert an AnalysisResult to an array of Cytoscape ElementDefinitions.
 */
export function convertToCytoscapeElements(
  result: AnalysisResult,
): ElementDefinition[] {
  const elements: ElementDefinition[] = [];
  const { screens, transitions } = result;

  // Build parent group nodes for nested routes
  const parentPaths = collectParentPaths(screens);
  // Check which parent paths actually correspond to existing screens
  const screenPathSet = new Set(screens.map((s) => s.path));

  for (const parentPath of parentPaths) {
    // Only create standalone group node if no screen already owns this path
    if (!screenPathSet.has(parentPath)) {
      elements.push({
        data: {
          id: `group:${parentPath}`,
          label: parentPath,
          isGroup: true,
        },
      });
    }
  }

  // Screen nodes
  for (const screen of screens) {
    const parent = deriveParentPath(screen.path);
    let parentId: string | undefined;
    if (parent !== null) {
      // Point to the group node or the screen that owns the parent path
      if (screenPathSet.has(parent) && parentPaths.has(parent)) {
        parentId = `group:${parent}`;
        // Ensure a group wrapper exists for screens that double as parents
        if (!elements.some((e) => e.data["id"] === parentId)) {
          elements.push({
            data: {
              id: parentId,
              label: parent,
              isGroup: true,
            },
          });
        }
      } else if (parentPaths.has(parent)) {
        parentId = `group:${parent}`;
      }
    }

    const nodeData: Record<string, unknown> = {
      id: screen.id,
      label: screen.label,
      path: screen.path,
      componentFile: screen.componentFile,
      description: screen.description,
      variantCount: screen.variants.length,
      variants: screen.variants,
      parent: parentId,
    };

    elements.push({ data: nodeData });
  }

  // Transition edges
  for (const transition of transitions) {
    const method = classifyMethod(transition.method);
    const edgeData: Record<string, unknown> = {
      id: transition.id,
      source: transition.from,
      target: transition.to,
      label: transition.trigger,
      method,
    };

    // Only include condition key when present, so Cytoscape's
    // `edge[condition]` selector doesn't match unconditional edges.
    if (transition.condition != null) {
      edgeData["condition"] = transition.condition;
    }

    elements.push({ data: edgeData });
  }

  return elements;
}
