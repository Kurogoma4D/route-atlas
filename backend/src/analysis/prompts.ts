/**
 * LLM Prompt Templates
 *
 * Structured prompts for each turn of the multi-turn analysis pipeline.
 * Each prompt asks the LLM to return strictly valid JSON so the result
 * can be parsed deterministically.
 *
 * Flow B (issue #90): prompts include **file paths only** — the LLM pulls
 * the actual contents through the `readFile` / `searchFiles` / `grepFiles`
 * tools exposed by the pipeline. The snippet helpers at the bottom of the
 * file are kept for callers that still need them (and their tests).
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

You have three tools to fetch repository content on demand:
- readFile(path): returns the contents of a single file at the given repo path.
- searchFiles(pattern): returns repo paths matching a glob (e.g. "src/**/*.tsx").
- grepFiles(query, glob?): full-text / code search over the repository.

Read only the files you actually need. It is cheaper and more accurate to
inspect a handful of targeted files than to try to enumerate the whole repo.

IMPORTANT: After you finish using tools, respond with ONLY valid JSON —
no markdown fences, no explanatory text before or after the JSON.`;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Render a bullet list of file paths, capped so the prompt stays compact. */
function formatPathList(paths: string[], max = 200): string {
  if (paths.length === 0) return "(none provided)";
  const shown = paths.slice(0, max);
  const extra = paths.length - shown.length;
  const body = shown.map((p) => `- ${p}`).join("\n");
  return extra > 0 ? `${body}\n…and ${extra} more` : body;
}

// ---------------------------------------------------------------------------
// Turn 1 — Route / screen extraction
// ---------------------------------------------------------------------------

export function buildTurn1Prompt(
  framework: string,
  routingFilePaths: string[],
): string {
  const isPlainHtml = framework === "plain-html";
  const isAstro = isAstroFramework(framework);
  const isAndroid = isAndroidFramework(framework);
  const isIOS = isIOSFramework(framework);
  const isFlutter = isFlutterFramework(framework);
  const isReactNative = isReactNativeFramework(framework);

  let frameworkInstructions: string;

  if (isReactNative) {
    if (framework === "expo-router") {
      frameworkInstructions = `Analyze the Expo Router files listed below and extract every screen / route.

For Expo Router projects (file-based routing similar to Next.js App Router):
- Each file under app/ represents a route. The file path maps to the URL route (e.g. app/(tabs)/home.tsx -> /home, app/profile/[id].tsx -> /profile/[id]).
- _layout.tsx files define navigation structure using <Tabs>, <Stack>, or <Drawer> components.
- (group) directories (parenthesized names) are route groups — they do NOT appear in the URL path but organize navigation structure.
- [param] and [...catchAll] represent dynamic route segments.
- Files named index.tsx represent the default route for their directory.

Use the file-based route path as the "path" (e.g. "/", "/home", "/profile/[id]").
Set "componentFile" to the .tsx/.jsx file path.`;
    } else {
      frameworkInstructions = `Analyze the React Navigation files listed below and extract every screen / route.

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

    frameworkInstructions = `Analyze the Flutter ${flutterLibLabel} files listed below and extract every screen / route.

For Flutter projects, identify screens from:
- go_router: GoRoute(path: '...', builder: ...) and ShellRoute / StatefulShellRoute definitions
- auto_route: @RoutePage() annotated widgets and AutoRouter / AppRouter route lists
- Navigator 1.0: MaterialApp "routes" map entries and onGenerateRoute handler

Use the route path string as the "path" (e.g. "/home", "/user/:id").
For Navigator 1.0 named routes, use the route name (e.g. "/settings").
Set "componentFile" to the .dart file path containing the screen widget.`;
  } else if (framework === "tanstack-router") {
    frameworkInstructions = `Analyze the TanStack Router files listed below and extract every screen / route.

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
    frameworkInstructions = `Analyze the Gatsby page files listed below and extract every screen / route.

For Gatsby projects (file-based routing similar to Next.js Pages Router):
- Each file under src/pages/ represents a route. The file path maps to the URL route (e.g. src/pages/index.tsx -> /, src/pages/about.tsx -> /about, src/pages/blog/index.tsx -> /blog).
- Dynamic routes use curly brace notation: src/pages/{slug}.tsx -> /:slug, src/pages/users/{id}.tsx -> /users/:id.
- Files named index.tsx represent the default route for their directory.
- gatsby-node.js createPages API can generate additional dynamic pages — infer these from the source if visible.

Use the file-based route path as the "path" (e.g. "/", "/about", "/blog/:slug").
Set "componentFile" to the .tsx/.jsx/.ts/.js file path.`;
  } else if (isAstro) {
    frameworkInstructions = `Analyze the Astro page files listed below and extract every screen / route.

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
    frameworkInstructions = `Analyze the SolidStart routing files listed below and extract every screen / route.

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
    frameworkInstructions = `Analyze the Qwik City routing files listed below and extract every screen / route.

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
    frameworkInstructions = `Analyze the Ember.js routing files listed below and extract every screen / route.

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
    frameworkInstructions = `Analyze the plain HTML files listed below. Each HTML file represents a screen.
Use the file path prefixed with "/" as the URL route path (e.g. "about.html" becomes "/about.html", "contact/index.html" becomes "/contact/index.html").
Set "componentFile" to the same HTML file path (without the leading "/").`;
  } else if (isAndroid) {
    frameworkInstructions = `Analyze the Android ${framework === "android-compose-navigation" ? "Jetpack Compose Navigation" : "Navigation Component"} files listed below and extract every screen / destination.

For Android projects, identify screens from:
- Navigation XML: <fragment>, <dialog>, <activity> elements with android:name and android:id attributes
- Compose Navigation: composable("route") calls inside NavHost definitions
- Activity classes: classes extending Activity/AppCompatActivity
- Fragment classes: classes extending Fragment

Use the navigation destination route string as the "path" (e.g. "home", "settings/{userId}").
For Activities without navigation routes, use the class name as the path (e.g. "MainActivity", "SettingsActivity").
Set "componentFile" to the Kotlin/Java source file path.`;
  } else if (isIOS) {
    frameworkInstructions = `Analyze the iOS ${framework === "ios-swiftui" ? "SwiftUI" : "UIKit"} files listed below and extract every screen / destination.

For iOS projects, identify screens from:
- Storyboard XML: <viewController> and <scene> elements with storyboardIdentifier attributes
- SwiftUI: Views used inside NavigationStack, NavigationView, NavigationSplitView, or TabView
- UIViewController subclasses: classes extending UIViewController or its subclasses
- Coordinator/Router pattern: navigation targets defined in Coordinator or Router classes

Use the Storyboard ID, SwiftUI navigation destination value, or class name as the "path" (e.g. "HomeView", "SettingsViewController", "profileDetail").
Set "componentFile" to the .swift, .m, or .storyboard file path.`;
  } else {
    frameworkInstructions = `Analyze the ${framework} routing files listed below and extract every screen / route.`;
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

  const paths = formatPathList(routingFilePaths);

  return `${frameworkInstructions}

To inspect any of these files call the \`readFile\` tool with the path. Use
\`searchFiles\` or \`grepFiles\` only if the routing-file list is incomplete
and you need to locate extra definitions (e.g. a root route file that is
\`import\`ed from a listed file).

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

### Routing file paths
${paths}`;
}

// ---------------------------------------------------------------------------
// Turn 2 — State variant extraction
// ---------------------------------------------------------------------------

export function buildTurn2Prompt(
  screenId: string,
  componentFile: string,
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

  return `Analyze screen "${screenId}" (component file \`${componentFile}\`) and extract all state variants.

Start by calling \`readFile\` with the path above. If the component composes
child components that clearly hold state branches, you MAY read those too —
prefer \`grepFiles\` / \`searchFiles\` to locate them before \`readFile\`.

Look for:
${lookForItems}

For each variant return:
- "id": unique snake_case identifier (e.g. "variant_loading_dashboard")
- "label": human-readable name (e.g. "Loading state")
- "condition": description of when this variant appears
- "type": one of "loading" | "error" | "empty" | "auth_required" | "permission" | "responsive" | "conditional"

Return a JSON array. If no variants are found, return an empty array [].`;
}

// ---------------------------------------------------------------------------
// Snippet extraction helpers (retained for callers outside the pipeline)
// ---------------------------------------------------------------------------

/**
 * Return regex patterns that match navigation-related code for the given framework.
 * Kept exported because consumers and tests still rely on these patterns.
 */
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
  screens: { id: string; path: string; componentFile: string }[],
  componentFilePaths: string[],
  framework: FrameworkName,
): string {
  const screenList = screens
    .map((s) => `- ${s.id} (${s.path}) — ${s.componentFile}`)
    .join("\n");

  const paths = formatPathList(componentFilePaths);

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

  return `Extract all screen-to-screen transitions (navigations) in the codebase.

Known screens (id / path / componentFile):
${screenList}

Strategy:
1. Start with the component files for the screens above — call \`readFile\`
   for each one whose navigation behaviour you need to inspect.
2. Use \`grepFiles\` with keywords from the "Look for" list (e.g. \`useNavigate\`,
   \`router.push\`, \`NavigationLink\`) to locate transitions that live in shared
   helpers, hooks, or layout files.
3. Use \`searchFiles\` to enumerate a subdirectory if grep returns nothing.
4. Only include transitions between the known screens listed above.

Look for:
${lookForItems}

For each transition return:
- "id": unique snake_case identifier (e.g. "transition_home_to_login")
- "from": the source screen id
- "to": the target screen id
- "trigger": description of what triggers the navigation (e.g. "Click login button")
- "method": the code method used (e.g. ${methodExamples})
- "condition": (optional) any condition that must be true for the transition to occur

Return a JSON array. If no transitions are found, return an empty array [].

### Candidate source file paths (prefer these when browsing)
${paths}`;
}
