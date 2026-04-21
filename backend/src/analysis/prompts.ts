/**
 * LLM Prompt Templates
 *
 * Structured prompts for each turn of the multi-turn analysis pipeline.
 * Each prompt asks the LLM to return strictly valid JSON so the result
 * can be parsed deterministically.
 *
 * Reference: SPEC.md §5.4
 */

import type { FrameworkName } from "./framework-detector.js";
import {
  isAndroidFramework,
  isIOSFramework,
  isFlutterFramework,
  isReactNativeFramework,
  isAstroFramework,
  isEmberFramework,
} from "./framework-detector.js";

// ---------------------------------------------------------------------------
// System prompt (shared across all turns)
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `You are a source code analysis assistant.
You analyze source code and extract structured information about screens,
state variations, and navigation transitions.

IMPORTANT: Always respond with ONLY valid JSON — no markdown fences, no
explanatory text before or after the JSON.`;

/**
 * System prompt variant used when custom file-access tools (readFile,
 * searchFiles, grepFiles) are available. Encourages the model to fetch only
 * what it needs instead of expecting every relevant file to be embedded.
 */
export const SYSTEM_PROMPT_WITH_TOOLS = `You are a source code analysis assistant.
You analyze source code and extract structured information about screens,
state variations, and navigation transitions.

You have access to custom tools for exploring the repository on demand:
- readFile(path): fetch the contents of a single file by its repository-relative path.
- searchFiles(pattern): list file paths matching a minimatch glob pattern.
- grepFiles(query, glob?): find a literal substring across files (optionally scoped by a glob).

Use these tools to read only the files you actually need. Do NOT request the
same file more than once in a single turn. Prefer narrow globs over broad ones
to keep tool responses small.

IMPORTANT: After you have finished exploring, your FINAL response must be
ONLY valid JSON — no markdown fences, no explanatory text before or after the
JSON. Do not describe your reasoning in the final message.`;

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
  const isAstro = isAstroFramework(framework);
  const isAndroid = isAndroidFramework(framework);
  const isIOS = isIOSFramework(framework);
  const isFlutter = isFlutterFramework(framework);
  const isReactNative = isReactNativeFramework(framework);

  let frameworkInstructions: string;

  if (isReactNative) {
    if (framework === "expo-router") {
      frameworkInstructions = `Analyze the following Expo Router files and extract every screen / route.

For Expo Router projects (file-based routing similar to Next.js App Router):
- Each file under app/ represents a route. The file path maps to the URL route (e.g. app/(tabs)/home.tsx -> /home, app/profile/[id].tsx -> /profile/[id]).
- _layout.tsx files define navigation structure using <Tabs>, <Stack>, or <Drawer> components.
- (group) directories (parenthesized names) are route groups — they do NOT appear in the URL path but organize navigation structure.
- [param] and [...catchAll] represent dynamic route segments.
- Files named index.tsx represent the default route for their directory.

Use the file-based route path as the "path" (e.g. "/", "/home", "/profile/[id]").
Set "componentFile" to the .tsx/.jsx file path.`;
    } else {
      frameworkInstructions = `Analyze the following React Navigation files and extract every screen / route.

For React Navigation projects (v5+):
- createStackNavigator(), createNativeStackNavigator() define stack-based navigation.
- createBottomTabNavigator() defines tab navigation.
- createDrawerNavigator() defines drawer navigation.
- Extract screens from <Stack.Screen name="..." component={...} />, <Tab.Screen>, <Drawer.Screen> elements.
- Nested navigators define hierarchical navigation structure.

Use the screen name as the "path" (e.g. "Home", "Profile", "Settings").
Set "componentFile" to the .tsx/.jsx file path containing the screen component.`;
    }
  } else if (isFlutter) {
    const flutterLibLabel =
      framework === "flutter-go-router"
        ? "go_router (GoRoute / ShellRoute / StatefulShellRoute)"
        : framework === "flutter-auto-route"
          ? "auto_route (@RoutePage() annotations, AutoRouter definitions)"
          : "Navigator 1.0 (MaterialApp routes / onGenerateRoute)";

    frameworkInstructions = `Analyze the following Flutter ${flutterLibLabel} files and extract every screen / route.

For Flutter projects, identify screens from:
- go_router: GoRoute(path: '...', builder: ...) and ShellRoute / StatefulShellRoute definitions
- auto_route: @RoutePage() annotated widgets and AutoRouter / AppRouter route lists
- Navigator 1.0: MaterialApp "routes" map entries and onGenerateRoute handler

Use the route path string as the "path" (e.g. "/home", "/user/:id").
For Navigator 1.0 named routes, use the route name (e.g. "/settings").
Set "componentFile" to the .dart file path containing the screen widget.`;
  } else if (framework === "tanstack-router") {
    frameworkInstructions = `Analyze the following TanStack Router files and extract every screen / route.

For TanStack Router projects:
- createFileRoute('/path') defines file-based routes where the path argument is the route path.
- createRootRoute() defines the root layout route.
- createRoute() defines code-based routes with a path option.
- routeTree.gen.ts contains the auto-generated route tree — extract all routes from this file when present.
- createRouter({ routeTree }) wires the route tree to the router instance.
- File-based routing: files under src/routes/ map to URL paths (e.g. src/routes/about.tsx -> /about, src/routes/posts/$postId.tsx -> /posts/$postId).
- $param segments represent dynamic route parameters.
- _layout files define layout routes (shared UI wrappers).
- index.tsx files represent the default route for their directory.

Use the route path as the "path" (e.g. "/", "/about", "/posts/$postId").
Set "componentFile" to the .tsx/.jsx/.ts/.js file path.`;
  } else if (framework === "gatsby") {
    frameworkInstructions = `Analyze the following Gatsby page files and extract every screen / route.

For Gatsby projects (file-based routing similar to Next.js Pages Router):
- Each file under src/pages/ represents a route. The file path maps to the URL route (e.g. src/pages/index.tsx -> /, src/pages/about.tsx -> /about, src/pages/blog/index.tsx -> /blog).
- Dynamic routes use curly brace notation: src/pages/{slug}.tsx -> /:slug, src/pages/users/{id}.tsx -> /users/:id.
- Files named index.tsx represent the default route for their directory.
- gatsby-node.js createPages API can generate additional dynamic pages — infer these from the source if visible.

Use the file-based route path as the "path" (e.g. "/", "/about", "/blog/:slug").
Set "componentFile" to the .tsx/.jsx/.ts/.js file path.`;
  } else if (isAstro) {
    frameworkInstructions = `Analyze the following Astro page files and extract every screen / route.

For Astro projects (file-based routing):
- Each file under src/pages/ represents a route. The file path maps to the URL route (e.g. src/pages/index.astro -> /, src/pages/about.astro -> /about, src/pages/blog/[slug].astro -> /blog/:slug).
- Supported page extensions: .astro, .md, .mdx, .tsx, .jsx, .ts, .js.
- Files named index.{astro,md,mdx} represent the default route for their directory.
- [param] brackets represent dynamic route segments: src/pages/blog/[slug].astro -> /blog/:slug.
- [...spread] represents catch-all routes: src/pages/[...path].astro -> /:path*.
- API routes under src/pages/api/ (e.g. src/pages/api/search.ts) are server endpoints, NOT screens — exclude them from the result.

Use the file-based route path as the "path" (e.g. "/", "/about", "/blog/:slug").
Set "componentFile" to the .astro/.md/.mdx/.tsx/.jsx file path.`;
  } else if (framework === "solid-start") {
    frameworkInstructions = `Analyze the following SolidStart routing files and extract every screen / route.

For SolidStart projects (file-based routing similar to SvelteKit):
- Each file under src/routes/ represents a route. The file path maps to the URL route (e.g. src/routes/index.tsx -> /, src/routes/about.tsx -> /about, src/routes/users/[id].tsx -> /users/:id).
- Files named index.tsx represent the default route for their directory.
- [param] brackets represent dynamic route segments: src/routes/users/[id].tsx -> /users/:id.
- [...catchAll] represents catch-all routes.
- (group) directories (parenthesized names) are route groups — they do NOT appear in the URL path but organize routes logically.
- API routes (files that only export GET, POST, PUT, DELETE, etc. request handler functions under src/routes/api/) are server endpoints, NOT screens — exclude them from the result.

Use the file-based route path as the "path" (e.g. "/", "/about", "/users/:id").
Set "componentFile" to the .tsx/.jsx/.ts/.js file path.`;
  } else if (framework === "qwik-city") {
    frameworkInstructions = `Analyze the following Qwik City routing files and extract every screen / route.

For Qwik City projects (directory-based routing):
- Each directory under src/routes/ with an index.tsx represents a route. The directory path maps to the URL route (e.g. src/routes/index.tsx -> /, src/routes/about/index.tsx -> /about, src/routes/blog/[slug]/index.tsx -> /blog/:slug).
- Files named index.tsx (or index.jsx, index.ts, index.js) represent the page component for their directory.
- [param] brackets represent dynamic route segments: src/routes/blog/[slug]/index.tsx -> /blog/:slug.
- [...catchAll] represents catch-all routes.
- (group) directories (parenthesized names) are route groups — they do NOT appear in the URL path but organize routes logically.
- layout.tsx files are layout definitions that wrap child routes — they are NOT screens. Do NOT include them as separate screens.
- API routes (files that only export onGet, onPost, onPut, onDelete request handler functions) are server endpoints, NOT screens — exclude them from the result.

Use the directory-based route path as the "path" (e.g. "/", "/about", "/blog/:slug").
Set "componentFile" to the index.tsx/.jsx/.ts/.js file path.`;
  } else if (isEmberFramework(framework)) {
    frameworkInstructions = `Analyze the following Ember.js routing files and extract every screen / route.

For Ember.js projects (convention-based routing):
- app/router.js (or app/router.ts) contains route definitions using this.route('name', ...) inside Router.map(function() { ... }).
- Nested routes are defined by passing a callback: this.route('parent', function() { this.route('child'); }) which produces the path /parent/child.
- this.route('name') maps to the path /name by default (e.g. this.route('about') -> /about).
- this.route('name', { path: '/custom' }) overrides the default path.
- Each route in app/routes/**/*.js (or .ts) is a Route class that corresponds to a route definition.
- The index route (this.route('index') or implicit) maps to "/".
- Files under app/routes/ follow Ember conventions: app/routes/about.js corresponds to the "about" route.

Use the route path as the "path" (e.g. "/", "/about", "/posts/:post_id").
Set "componentFile" to the route file path (e.g. "app/routes/about.js") or the router file if no dedicated route file exists.`;
  } else if (isPlainHtml) {
    frameworkInstructions = `Analyze the following plain HTML files. Each HTML file represents a screen.
Use the file path prefixed with "/" as the URL route path (e.g. "about.html" becomes "/about.html", "contact/index.html" becomes "/contact/index.html").
Set "componentFile" to the same HTML file path (without the leading "/").`;
  } else if (isAndroid) {
    frameworkInstructions = `Analyze the following Android ${framework === "android-compose-navigation" ? "Jetpack Compose Navigation" : "Navigation Component"} files and extract every screen / destination.

For Android projects, identify screens from:
- Navigation XML: <fragment>, <dialog>, <activity> elements with android:name and android:id attributes
- Compose Navigation: composable("route") calls inside NavHost definitions
- Activity classes: classes extending Activity/AppCompatActivity
- Fragment classes: classes extending Fragment

Use the navigation destination route string as the "path" (e.g. "home", "settings/{userId}").
For Activities without navigation routes, use the class name as the path (e.g. "MainActivity", "SettingsActivity").
Set "componentFile" to the Kotlin/Java source file path.`;
  } else if (isIOS) {
    frameworkInstructions = `Analyze the following iOS ${framework === "ios-swiftui" ? "SwiftUI" : "UIKit"} files and extract every screen / destination.

For iOS projects, identify screens from:
- Storyboard XML: <viewController> and <scene> elements with storyboardIdentifier attributes
- SwiftUI: Views used inside NavigationStack, NavigationView, NavigationSplitView, or TabView
- UIViewController subclasses: classes extending UIViewController or its subclasses
- Coordinator/Router pattern: navigation targets defined in Coordinator or Router classes

Use the Storyboard ID, SwiftUI navigation destination value, or class name as the "path" (e.g. "HomeView", "SettingsViewController", "profileDetail").
Set "componentFile" to the .swift, .m, or .storyboard file path.`;
  } else {
    frameworkInstructions = `Analyze the following ${framework} routing files and extract every screen / route.`;
  }

  const exampleComponentFile = isReactNative
    ? framework === "expo-router"
      ? "app/(tabs)/home.tsx"
      : "src/screens/HomeScreen.tsx"
    : isFlutter
      ? "lib/screens/home_screen.dart"
      : isAstro
        ? "src/pages/index.astro"
        : isPlainHtml
          ? "index.html"
          : isAndroid
            ? "app/src/main/java/com/example/HomeFragment.kt"
            : isIOS
              ? "Sources/Views/HomeView.swift"
              : isEmberFramework(framework)
                ? "app/routes/index.js"
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
  framework: FrameworkName,
): string {
  const isAstro = isAstroFramework(framework);
  const isAndroid = isAndroidFramework(framework);
  const isIOS = isIOSFramework(framework);
  const isFlutter = isFlutterFramework(framework);
  const isReactNative = isReactNativeFramework(framework);

  let lookForItems: string;

  if (isReactNative) {
    lookForItems = `- Loading states (ActivityIndicator, skeleton/shimmer components)
- Error states (error message views, Alert.alert for errors, error boundaries)
- Empty states (FlatList / SectionList ListEmptyComponent, no-data messages)
- Platform-specific rendering (Platform.OS, Platform.select())
- Responsive variants (useWindowDimensions(), Dimensions API)
- React Query / SWR / Apollo loading/error/data states
- Authentication-required states (login redirects, auth guards)
- Permission-based rendering (role checks)
- Other conditional rendering (feature flags, A/B tests)`;
  } else if (isFlutter) {
    lookForItems = `- Loading states (CircularProgressIndicator, LinearProgressIndicator, Shimmer / skeleton widgets)
- Error states (error message widgets, SnackBar errors, AlertDialog for errors)
- Empty states (no-data messages, empty list placeholders)
- FutureBuilder / StreamBuilder with ConnectionState branching (waiting, active, done, error)
- BlocBuilder / BlocConsumer state branching (BLoC pattern)
- Consumer / Selector state branching (Riverpod / Provider)
- AsyncValue.when() pattern (Riverpod)
- Authentication-required states (login redirects, auth guards)
- Permission-based rendering (role checks)
- LayoutBuilder / MediaQuery responsive variants
- Other conditional rendering (feature flags, platform checks)`;
  } else if (isAndroid) {
    lookForItems = `- Loading states (ProgressBar, CircularProgressIndicator, LinearProgressIndicator, shimmer/skeleton composables)
- Error states (Snackbar, Toast, AlertDialog for errors, try-catch blocks with error UI)
- Empty states (no-data messages, empty list placeholders, EmptyView)
- Authentication-required states (login redirects, auth checks)
- Permission-based rendering (role checks, admin-only sections)
- Conditional rendering via "when" statements or "if" blocks that change displayed content
- Other conditional rendering (feature flags, BuildConfig checks)`;
  } else if (isIOS) {
    lookForItems = `- Loading states (ProgressView in SwiftUI, UIActivityIndicatorView in UIKit, skeleton/shimmer views)
- Error states (Alert in SwiftUI, UIAlertController in UIKit, error message views)
- Empty states (no-data messages, empty list placeholders, ContentUnavailableView)
- Authentication-required states (login redirects, auth checks)
- Permission-based rendering (role checks, entitlement checks)
- @ViewBuilder conditional rendering (if/else, switch statements inside view body)
- @Environment / @EnvironmentObject / @State / @Binding driven state changes
- Other conditional rendering (feature flags, #if DEBUG checks)`;
  } else if (isAstro) {
    lookForItems = `- Frontmatter conditionals (if/else in the --- block that change rendered content)
- Astro.redirect() calls in frontmatter (server-side redirects)
- Loading states (skeleton components, loading placeholders)
- Error states (error message components, try-catch in frontmatter)
- Empty states (no-data messages, empty list placeholders)
- Authentication-required states (auth checks in frontmatter, Astro.redirect to login)
- Permission-based rendering (role checks)
- Dynamic rendering based on Astro.request, Astro.url, Astro.params
- Other conditional rendering (feature flags, environment checks via import.meta.env)`;
  } else {
    lookForItems = `- Loading states (spinners, skeletons, suspense boundaries)
- Error states (error boundaries, catch blocks, error UI)
- Empty states (no-data messages, empty list placeholders)
- Authentication-required states (login redirects, auth guards)
- Permission-based rendering (role checks, admin-only sections)
- Responsive variants (conditional rendering based on screen size, breakpoint checks in component logic)
- Other conditional rendering (feature flags, A/B tests)`;
  }

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
// Snippet extraction for Turn 3 token reduction
// ---------------------------------------------------------------------------

/**
 * Return regex patterns that match navigation-related code for the given framework.
 * These are derived from the Turn 3 `lookForItems` lists.
 */
/**
 * Literal substrings (not regexes) the Copilot `grepFiles` tool can use to
 * locate navigation call sites in each supported framework.
 *
 * These must be **literal** — `grepFiles` performs a plain substring search,
 * not a regex match. Keywords are chosen to be high-signal: each one should
 * strongly suggest an actual navigation call when it appears in a source
 * file, with few false positives.
 *
 * Used by `buildTurn3ToolPrompt` to hint the model what to grep for first.
 */
export const NAV_KEYWORDS_BY_FRAMEWORK: Record<FrameworkName, string[]> = {
  // React Router / Next.js / Vue Router / Svelte / etc. (web-common default)
  "react-router": ["useNavigate", "navigate(", "<Link ", "<NavLink ", 'to="'],
  "nextjs-app": [
    "router.push(",
    "router.replace(",
    "useRouter",
    "<Link ",
    "redirect(",
  ],
  "nextjs-pages": [
    "router.push(",
    "router.replace(",
    "useRouter",
    "<Link ",
    "redirect(",
  ],
  "vue-router": [
    "router.push(",
    "router.replace(",
    "<router-link",
    "<RouterLink",
    "$router.push",
  ],
  nuxt: ["navigateTo(", "useRouter", "<NuxtLink", "<router-link"],
  angular: ["this.router.navigate", "router.navigate(", "routerLink", "Router"],
  "tanstack-router": ["useNavigate", "navigate(", "<Link ", "router.navigate"],
  remix: ["useNavigate", "navigate(", "<Link ", "<NavLink ", "redirect("],
  sveltekit: ["goto(", "<a href", "$app/navigation"],
  gatsby: ["<Link ", "navigate(", "gatsby-link"],
  "solid-start": ["useNavigate", "navigate(", "<A ", "<Navigate "],
  "qwik-city": ["useNavigate", "<Link ", "routeLoader$"],
  // Plain HTML / Astro
  "plain-html": ['href="', "href='", "window.location", "location.href"],
  astro: ['href="', "href='", "Astro.redirect", "ViewTransitions"],
  // Ember
  ember: ["<LinkTo", "{{link-to", "this.router.transitionTo", "transitionTo("],
  // React Native
  "react-navigation": [
    "navigation.navigate(",
    "navigation.push(",
    "navigation.replace(",
    "Stack.Screen",
  ],
  "expo-router": ["router.push(", "router.replace(", "<Link ", "useRouter"],
  // Flutter
  "flutter-go-router": [
    "context.go(",
    "context.push(",
    "context.goNamed(",
    "GoRouter.of",
  ],
  "flutter-auto-route": [
    "context.router.push",
    "context.router.pushRoute",
    "AutoRouter",
  ],
  "flutter-navigator": [
    "Navigator.push(",
    "Navigator.pushNamed(",
    "Navigator.pushReplacement(",
    "Navigator.pop(",
  ],
  // iOS
  "ios-swiftui": [
    "NavigationLink",
    ".navigationDestination",
    ".sheet(",
    ".fullScreenCover(",
  ],
  "ios-uikit": [
    "pushViewController",
    ".present(",
    "performSegue",
    "popViewController",
  ],
  // Android
  "android-navigation": [
    "findNavController()",
    "navController.navigate",
    "NavController",
    "app:destination",
  ],
  "android-compose-navigation": [
    "navController.navigate(",
    "rememberNavController",
    "NavHost",
    "composable(",
  ],
};

export function getNavigationPatterns(framework: FrameworkName): RegExp[] {
  if (isReactNativeFramework(framework)) {
    return [
      /navigation\.(navigate|push|goBack|popToTop|replace|reset|dispatch)/,
      /router\.(push|replace)/,
      /\bLink\b/,
      /CommonActions\.navigate/,
      /StackActions\.(push|pop)/,
    ];
  }
  if (isFlutterFramework(framework)) {
    return [
      /Navigator\.(push|pushNamed|pushReplacement|pop|popUntil|popAndPushNamed|of)/,
      /context\.(go|push|goNamed|pushNamed)/,
      /GoRouter\.of/,
      /context\.router\.(push|pushRoute|pop)/,
      /show(Dialog|ModalBottomSheet|CupertinoDialog|CupertinoModalPopup|GeneralDialog|BottomSheet)/,
    ];
  }
  if (isAndroidFramework(framework)) {
    return [
      /NavController\.navigate|findNavController\(\)\.navigate/,
      /navController\.navigate/,
      /startActivity|startActivityForResult/,
      /FragmentTransaction\.(replace|add|show)/,
      /popBackStack|navigateUp/,
      /app:destination/,
    ];
  }
  if (isIOSFramework(framework)) {
    return [
      /NavigationLink/,
      /\.navigationDestination/,
      /\.(sheet|fullScreenCover|popover)\(/,
      /pushViewController|\.present\(/,
      /performSegue/,
      /coordinator\.(navigate|push)/i,
      /TabView/,
      /dismiss\(\)|popViewController/,
    ];
  }
  if (isAstroFramework(framework)) {
    return [
      /\bhref\s*=\s*["']/,
      /Astro\.redirect/,
      /window\.location|location\.href/,
      /ViewTransitions/,
      /data-astro-reload/,
    ];
  }
  if (isEmberFramework(framework)) {
    return [
      /LinkTo|link-to/,
      /transitionTo|replaceWith/,
      /this\.router\.(transitionTo|replaceWith)/,
      /\bhref\s*=\s*["']/,
    ];
  }
  // Web common (Next.js, React Router, Vue Router, SvelteKit, etc.)
  return [
    /\bLink\b/,
    /router\.(push|navigate|replace)/,
    /\bnavigate\s*\(/,
    /\bredirect\s*\(/,
    /useNavigate/,
    /window\.location|location\.href/,
    /\bhref\s*=\s*["']/,
    /form\s+action\s*=/i,
  ];
}

/**
 * Extract only the lines relevant to navigation from a file's content.
 *
 * Returns the import block (top lines starting with `import` / `require` / `from`)
 * plus lines matching any of the given patterns with surrounding context.
 * Overlapping ranges are merged. Gaps between ranges are shown as `// ...`.
 *
 * Returns `null` if no navigation-related lines are found (imports alone are not enough).
 */
export function extractRelevantSnippets(
  content: string,
  patterns: RegExp[],
  contextLines = 5,
): string | null {
  const lines = content.split("\n");

  // Collect matched line indices
  const matchedIndices = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (patterns.some((p) => p.test(lines[i]))) {
      matchedIndices.add(i);
    }
  }

  if (matchedIndices.size === 0) return null;

  // Build ranges with context, then merge overlapping ones
  const ranges: [number, number][] = [];
  for (const idx of matchedIndices) {
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(lines.length - 1, idx + contextLines);
    ranges.push([start, end]);
  }
  ranges.sort((a, b) => a[0] - b[0]);

  const merged: [number, number][] = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const prev = merged[merged.length - 1];
    if (ranges[i][0] <= prev[1] + 1) {
      prev[1] = Math.max(prev[1], ranges[i][1]);
    } else {
      merged.push(ranges[i]);
    }
  }

  // Always include the import block at the top
  let importEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (
      trimmed.startsWith("import ") ||
      trimmed.startsWith("import(") ||
      trimmed.startsWith("from ") ||
      trimmed.startsWith("require(") ||
      trimmed.startsWith("const ") ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("*/") ||
      trimmed === ""
    ) {
      importEnd = i;
    } else {
      break;
    }
  }

  // If the first merged range already covers imports, skip separate import block
  const includeImports = importEnd >= 0 && merged[0][0] > importEnd + 1;

  const parts: string[] = [];
  if (includeImports) {
    parts.push(lines.slice(0, importEnd + 1).join("\n"));
    parts.push("// ...");
  }

  for (let i = 0; i < merged.length; i++) {
    const [start, end] = merged[i];
    if (i === 0 && !includeImports && start > 0) {
      parts.push("// ...");
    }
    parts.push(lines.slice(start, end + 1).join("\n"));
    if (i < merged.length - 1) {
      parts.push("// ...");
    } else if (end < lines.length - 1) {
      parts.push("// ...");
    }
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Turn 3 — Transition extraction
// ---------------------------------------------------------------------------

export function buildTurn3Prompt(
  screens: { id: string; path: string }[],
  allComponentSources: { path: string; content: string }[],
  framework: FrameworkName,
): string {
  const screenList = screens.map((s) => `- ${s.id} (${s.path})`).join("\n");

  // Extract only navigation-relevant snippets to reduce token usage
  const navPatterns = getNavigationPatterns(framework);
  const snippetFiles: { path: string; content: string }[] = [];
  for (const f of allComponentSources) {
    const snippet = extractRelevantSnippets(f.content, navPatterns);
    if (snippet !== null) {
      snippetFiles.push({ path: f.path, content: snippet });
    }
  }

  const filesSection = snippetFiles
    .map((f) => `### File: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
    .join("\n\n");

  const isAstro = isAstroFramework(framework);
  const isAndroid = isAndroidFramework(framework);
  const isIOS = isIOSFramework(framework);
  const isFlutter = isFlutterFramework(framework);
  const isReactNative = isReactNativeFramework(framework);

  let lookForItems: string;

  if (isReactNative) {
    lookForItems = `- navigation.navigate('ScreenName'), navigation.push('ScreenName')
- navigation.goBack(), navigation.popToTop()
- navigation.replace('ScreenName')
- router.push(), router.replace() (Expo Router)
- <Link href="..."> (Expo Router)
- CommonActions.navigate(), StackActions.push()
- Deep Link configuration (linking config)
- navigation.reset() (stack reset)
- navigation.dispatch() with custom actions`;
  } else if (isFlutter) {
    lookForItems = `- Navigator.push(), Navigator.pushNamed(), Navigator.pushReplacement(), Navigator.pushReplacementNamed()
- Navigator.pop(), Navigator.popUntil(), Navigator.popAndPushNamed()
- Navigator.of(context).push(), Navigator.of(context).pushNamed()
- context.go(), context.push(), context.goNamed(), context.pushNamed() (go_router)
- GoRouter.of(context).go(), GoRouter.of(context).push()
- context.router.push(), context.router.pushRoute(), context.router.pop() (auto_route)
- showDialog(), showModalBottomSheet(), showCupertinoDialog(), showCupertinoModalPopup()
- showGeneralDialog(), showBottomSheet()`;
  } else if (isAndroid) {
    lookForItems = `- NavController.navigate(), findNavController().navigate()
- navController.navigate("route") (Compose Navigation)
- startActivity(Intent(...)), startActivityForResult()
- FragmentTransaction.replace(), .add(), .show()
- popBackStack(), navigateUp()
- <action> elements in Navigation XML (app:destination attributes)
- Deep Link definitions (via <deepLink> elements or NavDeepLink)
- Safe Args navigation calls`;
  } else if (isIOS) {
    lookForItems = `- NavigationLink(destination:), NavigationLink(value:)
- .navigationDestination(for:) modifier
- .sheet(), .fullScreenCover(), .popover() (modal transitions)
- navigationController?.pushViewController(), .present() (UIKit push/modal)
- performSegue(withIdentifier:), Storyboard <segue> elements
- coordinator.navigate(to:) (Coordinator pattern)
- TabView tab switching
- dismiss(), navigationController?.popViewController() (back navigation)`;
  } else if (framework === "tanstack-router") {
    lookForItems = `- <Link to="..."/> from @tanstack/react-router
- useNavigate() hook with navigate({ to: '...' })
- router.navigate() programmatic navigation
- <Navigate to="..."/> component
- redirect() in loader or beforeLoad hooks
- window.location / location.href assignments`;
  } else if (framework === "gatsby") {
    lookForItems = `- <Link to="..."> from "gatsby" package
- navigate() from "gatsby" package
- navigate() from "@reach/router"
- <a href="..."> for external links
- window.location / location.href assignments
- Form submit handlers that navigate`;
  } else if (isAstro) {
    lookForItems = `- <a href="..."> (Astro uses standard HTML anchor tags for navigation by default)
- Astro.redirect() in frontmatter (server-side redirects)
- <ViewTransitions /> component usage (enables client-side navigation via View Transitions API)
- window.location / location.href assignments in <script> tags
- Form submit handlers that navigate
- data-astro-reload attribute (forces full page reload)
- Programmatic navigation in client-side island components (React/Vue/Svelte within client:* directives)`;
  } else if (framework === "solid-start") {
    lookForItems = `- <A href="..."> component from @solidjs/router
- useNavigate() hook for programmatic navigation
- redirect() in server functions (server-side redirects)
- <a href="..."> standard anchor tags
- window.location / location.href assignments
- Form submit handlers that navigate`;
  } else if (framework === "qwik-city") {
    lookForItems = `- <Link href="..."> component from @builder.io/qwik-city
- useNavigate() hook for programmatic navigation
- <Form> component with action-based navigation (@builder.io/qwik-city)
- <a href="..."> standard anchor tags
- window.location / location.href assignments
- Form submit handlers that navigate`;
  } else if (isEmberFramework(framework)) {
    lookForItems = `- <LinkTo @route="..."> component (Ember template navigation)
- this.transitionTo('routeName') in route classes
- this.replaceWith('routeName') in route classes
- this.router.transitionTo('routeName') via router service
- this.router.replaceWith('routeName') via router service
- {{link-to 'routeName'}} classic helper syntax
- <a href="..."> standard anchor tags
- window.location / location.href assignments`;
  } else {
    lookForItems = `- <Link>, <a href="...">, routerLink
- router.push(), router.navigate(), navigate()
- redirect(), useNavigate()
- window.location / location.href assignments
- <form action="..."> submit targets
- <meta http-equiv="refresh"> redirects
- Form submit handlers that navigate`;
  }

  const methodExamples = isReactNative
    ? `"navigation.navigate", "navigation.push", "router.push", "Link"`
    : isFlutter
      ? `"Navigator.push", "context.go", "context.router.push", "showDialog"`
      : isAndroid
        ? `"NavController.navigate", "startActivity", "popBackStack"`
        : isIOS
          ? `"NavigationLink", "pushViewController", "sheet"`
          : isAstro
            ? `"a href", "Astro.redirect", "window.location"`
            : framework === "tanstack-router"
              ? `"Link to", "navigate", "router.navigate", "redirect"`
              : framework === "gatsby"
                ? `"Link to", "navigate", "window.location"`
                : framework === "solid-start"
                  ? `"A href", "useNavigate", "redirect"`
                  : framework === "qwik-city"
                    ? `"Link href", "useNavigate", "Form"`
                    : isEmberFramework(framework)
                      ? `"LinkTo", "transitionTo", "replaceWith", "router.transitionTo"`
                      : `"Link", "router.push", "window.location"`;

  return `Analyze the following component source code excerpts (showing only navigation-related sections) and extract all screen-to-screen transitions (navigations).

Known screens:
${screenList}

Look for:
${lookForItems}

For each transition return:
- "id": unique snake_case identifier (e.g. "transition_home_to_login")
- "from": the source screen id
- "to": the target screen id
- "trigger": description of what triggers the navigation (e.g. "Click login button")
- "method": the code method used (e.g. ${methodExamples})
- "condition": (optional) any condition that must be true for the transition to occur

Only include transitions between the known screens listed above.
Return a JSON array. If no transitions are found, return an empty array [].

${filesSection}`;
}

// ---------------------------------------------------------------------------
// Tool-based prompts (Turn N variants used when custom Copilot tools are
// available). These provide a file list only and instruct the model to fetch
// relevant files via readFile / searchFiles / grepFiles.
// ---------------------------------------------------------------------------

/** Cap the file list embedded in tool-based prompts to keep tokens bounded. */
const TOOL_PROMPT_FILE_LIST_LIMIT = 500;

/** Format a file path list for embedding in a tool-based prompt. */
function formatFileList(
  paths: string[],
  limit = TOOL_PROMPT_FILE_LIST_LIMIT,
): string {
  const shown = paths.slice(0, limit);
  const suffix =
    paths.length > limit
      ? `\n... (${paths.length - limit} more files omitted — use searchFiles with a narrower glob to discover them)`
      : "";
  return `${shown.join("\n")}${suffix}`;
}

/**
 * Turn 1 prompt for the tool-enabled flow. Instead of embedding routing file
 * contents, lists candidate routing file paths and instructs the model to
 * read them via the `readFile` tool.
 */
export function buildTurn1ToolPrompt(
  framework: FrameworkName,
  routingFilePaths: string[],
): string {
  const fileList = formatFileList(routingFilePaths);

  return `Identify every screen / route in this ${framework} project.

The following files were detected as likely routing definitions:
${fileList}

Instructions:
1. Call readFile on each routing file (or the most promising ones) to inspect its contents.
2. If the routing definitions reference components in other files you need to verify, call readFile on those too. Use searchFiles / grepFiles to discover additional routing sources (e.g. nested route configs).
3. Do NOT read the same file twice.
4. Once you have enough information, return the final answer as a JSON array.

For each screen return a JSON object with these fields:
- "id": a unique snake_case identifier prefixed with "screen_" (e.g. "screen_dashboard")
- "path": the URL route path (e.g. "/dashboard")
- "componentFile": the component file path referenced in the route definition
- "label": a short human-readable name for the screen
- "description": a brief description of what the screen does

Return a JSON array of screen objects. If no screens are found, return [].`;
}

/**
 * Turn 2 prompt for the tool-enabled flow. Gives the model the target
 * component file path and asks it to fetch + analyse it via readFile.
 */
export function buildTurn2ToolPrompt(
  screenId: string,
  componentFile: string,
): string {
  return `Analyze the state variants for screen "${screenId}".

The component file is: ${componentFile}

Instructions:
1. Call readFile("${componentFile}") to retrieve the source.
2. If the component imports other components you also need to inspect, call readFile on those.
3. Identify all state variants (loading, error, empty, auth_required, permission, responsive, conditional).

For each variant return:
- "id": unique snake_case identifier (e.g. "variant_loading_dashboard")
- "label": human-readable name (e.g. "Loading state")
- "condition": description of when this variant appears
- "type": one of "loading" | "error" | "empty" | "auth_required" | "permission" | "responsive" | "conditional"

Return a JSON array. If no variants are found, return an empty array [].`;
}

/**
 * Turn 3 prompt for the tool-enabled flow. Provides the list of known screens
 * and the list of component file paths; asks the model to use grepFiles /
 * readFile to locate navigation calls.
 */
export function buildTurn3ToolPrompt(
  screens: { id: string; path: string }[],
  componentFilePaths: string[],
  framework: FrameworkName,
): string {
  const screenList = screens.map((s) => `- ${s.id} (${s.path})`).join("\n");
  const fileList = formatFileList(componentFilePaths);

  // `grepFiles` is a LITERAL substring search, so embed literal keywords
  // rather than regex source strings. The per-framework table is tuned so
  // each keyword unambiguously points at a navigation call. Wrap each
  // keyword in backticks so quote characters in the keyword itself (e.g.
  // `to="`) aren't confused with the delimiter.
  const keywords = NAV_KEYWORDS_BY_FRAMEWORK[framework] ?? [];
  const keywordList = keywords.map((k) => `- \`${k}\``).join("\n");

  return `Identify every screen-to-screen transition (navigation) in this ${framework} project.

Known screens:
${screenList}

Component files in the repository:
${fileList}

Instructions:
1. Use grepFiles with these LITERAL substrings (not regex) to locate navigation call sites:
${keywordList}
   (grepFiles performs a plain substring search. Feel free to add your own literal keywords when the ones above are insufficient.)
2. For each hit, call readFile on the containing file to understand the "from" and "to" screens and the trigger.
3. Only include transitions between the KNOWN screens listed above.
4. Do NOT read the same file twice.

For each transition return:
- "id": unique snake_case identifier (e.g. "transition_home_to_login")
- "from": the source screen id
- "to": the target screen id
- "trigger": description of what triggers the navigation (e.g. "Click login button")
- "method": the code method used (e.g. "router.push", "Link", "Navigator.push")
- "condition": (optional) any condition that must be true for the transition to occur

Return a JSON array. If no transitions are found, return an empty array [].`;
}
