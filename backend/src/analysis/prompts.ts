/**
 * LLM Prompt Templates
 *
 * Structured prompts for each turn of the multi-turn analysis pipeline.
 * Each prompt asks the LLM to return strictly valid JSON so the result
 * can be parsed deterministically.
 *
 * Reference: SPEC.md §5.4
 */

// ---------------------------------------------------------------------------
// System prompt (shared across all turns)
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `You are a frontend code analysis assistant.
You analyze source code and extract structured information about screens,
state variations, and navigation transitions.

IMPORTANT: Always respond with ONLY valid JSON — no markdown fences, no
explanatory text before or after the JSON.`;

// ---------------------------------------------------------------------------
// Turn 1 — Route / screen extraction
// ---------------------------------------------------------------------------

export function buildTurn1Prompt(
  framework: string,
  routingFiles: { path: string; content: string }[],
): string {
  const filesSection = routingFiles
    .map((f) => `### File: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
    .join("\n\n");

  return `Analyze the following ${framework} routing files and extract every screen / route.

For each screen return a JSON object with these fields:
- "id": a unique snake_case identifier prefixed with "screen_" (e.g. "screen_dashboard")
- "path": the URL route path (e.g. "/dashboard")
- "componentFile": the component file path referenced in the route definition
- "label": a short human-readable name for the screen
- "description": a brief description of what the screen does

Return a JSON array of screen objects. Example:
[
  {
    "id": "screen_home",
    "path": "/",
    "componentFile": "app/page.tsx",
    "label": "Home",
    "description": "Landing page of the application"
  }
]

${filesSection}`;
}

// ---------------------------------------------------------------------------
// Turn 2 — State variant extraction
// ---------------------------------------------------------------------------

export function buildTurn2Prompt(
  screenId: string,
  componentFile: string,
  componentSource: string,
): string {
  return `Analyze the following component source code for screen "${screenId}" and extract all state variants.

Look for:
- Loading states (spinners, skeletons, suspense boundaries)
- Error states (error boundaries, catch blocks, error UI)
- Empty states (no-data messages, empty list placeholders)
- Authentication-required states (login redirects, auth guards)
- Permission-based rendering (role checks, admin-only sections)
- Responsive variants (media queries, breakpoint-based rendering)
- Other conditional rendering (feature flags, A/B tests)

For each variant return:
- "id": unique snake_case identifier (e.g. "variant_loading_dashboard")
- "label": human-readable name (e.g. "Loading state")
- "condition": description of when this variant appears
- "type": one of "loading" | "error" | "empty" | "auth_required" | "permission" | "responsive" | "conditional"

Return a JSON array. If no variants are found, return an empty array [].

### File: ${componentFile}
\`\`\`
${componentSource}
\`\`\``;
}

// ---------------------------------------------------------------------------
// Turn 3 — Transition extraction
// ---------------------------------------------------------------------------

export function buildTurn3Prompt(
  screens: { id: string; path: string }[],
  allComponentSources: { path: string; content: string }[],
): string {
  const screenList = screens.map((s) => `- ${s.id} (${s.path})`).join("\n");

  const filesSection = allComponentSources
    .map((f) => `### File: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
    .join("\n\n");

  return `Analyze the following component source files and extract all screen-to-screen transitions (navigations).

Known screens:
${screenList}

Look for:
- <Link>, <a>, routerLink
- router.push(), router.navigate(), navigate()
- redirect(), useNavigate()
- window.location assignments
- Form submit handlers that navigate

For each transition return:
- "id": unique snake_case identifier (e.g. "transition_home_to_login")
- "from": the source screen id
- "to": the target screen id
- "trigger": description of what triggers the navigation (e.g. "Click login button")
- "method": the code method used (e.g. "Link", "router.push", "window.location")
- "condition": (optional) any condition that must be true for the transition to occur

Only include transitions between the known screens listed above.
Return a JSON array. If no transitions are found, return an empty array [].

${filesSection}`;
}
