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
// Helpers
// ---------------------------------------------------------------------------

function isAndroidFramework(framework: string): boolean {
  return framework === "android-navigation" || framework === "android-compose-navigation";
}

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

  const isPlainHtml = framework === "plain-html";
  const isAndroid = isAndroidFramework(framework);

  let frameworkInstructions: string;

  if (isPlainHtml) {
    frameworkInstructions =
      `Analyze the following plain HTML files. Each HTML file represents a screen.
Use the file path prefixed with "/" as the URL route path (e.g. "about.html" becomes "/about.html", "contact/index.html" becomes "/contact/index.html").
Set "componentFile" to the same HTML file path (without the leading "/").`;
  } else if (isAndroid) {
    frameworkInstructions =
      `Analyze the following Android ${framework === "android-compose-navigation" ? "Jetpack Compose Navigation" : "Navigation Component"} files and extract every screen / destination.

For Android projects, identify screens from:
- Navigation XML: <fragment>, <dialog>, <activity> elements with android:name and android:id attributes
- Compose Navigation: composable("route") calls inside NavHost definitions
- Activity classes: classes extending Activity/AppCompatActivity
- Fragment classes: classes extending Fragment

Use the navigation destination route string as the "path" (e.g. "home", "settings/{userId}").
For Activities without navigation routes, use the class name as the path (e.g. "MainActivity", "SettingsActivity").
Set "componentFile" to the Kotlin/Java source file path.`;
  } else {
    frameworkInstructions =
      `Analyze the following ${framework} routing files and extract every screen / route.`;
  }

  const exampleComponentFile = isPlainHtml
    ? "index.html"
    : isAndroid
      ? "app/src/main/java/com/example/HomeFragment.kt"
      : "app/page.tsx";

  return `${frameworkInstructions}

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
    "componentFile": "${exampleComponentFile}",
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
  framework?: string,
): string {
  const isAndroid = framework ? isAndroidFramework(framework) : false;

  const lookForItems = isAndroid
    ? `- Loading states (ProgressBar, CircularProgressIndicator, LinearProgressIndicator, shimmer/skeleton composables)
- Error states (Snackbar, Toast, AlertDialog for errors, try-catch blocks with error UI)
- Empty states (no-data messages, empty list placeholders, EmptyView)
- Authentication-required states (login redirects, auth checks)
- Permission-based rendering (role checks, admin-only sections)
- Conditional rendering via "when" statements or "if" blocks that change displayed content
- Other conditional rendering (feature flags, BuildConfig checks)`
    : `- Loading states (spinners, skeletons, suspense boundaries)
- Error states (error boundaries, catch blocks, error UI)
- Empty states (no-data messages, empty list placeholders)
- Authentication-required states (login redirects, auth guards)
- Permission-based rendering (role checks, admin-only sections)
- Responsive variants (conditional rendering based on screen size, breakpoint checks in component logic)
- Other conditional rendering (feature flags, A/B tests)`;

  return `Analyze the following component source code for screen "${screenId}" and extract all state variants.

Look for:
${lookForItems}

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
  framework?: string,
): string {
  const screenList = screens.map((s) => `- ${s.id} (${s.path})`).join("\n");

  const filesSection = allComponentSources
    .map((f) => `### File: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
    .join("\n\n");

  const isAndroid = framework ? isAndroidFramework(framework) : false;

  const lookForItems = isAndroid
    ? `- NavController.navigate(), findNavController().navigate()
- navController.navigate("route") (Compose Navigation)
- startActivity(Intent(...)), startActivityForResult()
- FragmentTransaction.replace(), .add(), .show()
- popBackStack(), navigateUp()
- <action> elements in Navigation XML (app:destination attributes)
- Deep Link definitions (via <deepLink> elements or NavDeepLink)
- Safe Args navigation calls`
    : `- <Link>, <a href="...">, routerLink
- router.push(), router.navigate(), navigate()
- redirect(), useNavigate()
- window.location / location.href assignments
- <form action="..."> submit targets
- <meta http-equiv="refresh"> redirects
- Form submit handlers that navigate`;

  return `Analyze the following component source files and extract all screen-to-screen transitions (navigations).

Known screens:
${screenList}

Look for:
${lookForItems}

For each transition return:
- "id": unique snake_case identifier (e.g. "transition_home_to_login")
- "from": the source screen id
- "to": the target screen id
- "trigger": description of what triggers the navigation (e.g. "Click login button")
- "method": the code method used (e.g. "${isAndroid ? "NavController.navigate" : "Link"}", "${isAndroid ? "startActivity" : "router.push"}", "${isAndroid ? "popBackStack" : "window.location"}")
- "condition": (optional) any condition that must be true for the transition to occur

Only include transitions between the known screens listed above.
Return a JSON array. If no transitions are found, return an empty array [].

${filesSection}`;
}
