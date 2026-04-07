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
import { isAndroidFramework, isIOSFramework, isFlutterFramework, isReactNativeFramework, isAstroFramework } from "./framework-detector.js";

// ---------------------------------------------------------------------------
// System prompt (shared across all turns)
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `You are a source code analysis assistant.
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
  const isAstro = isAstroFramework(framework);
  const isAndroid = isAndroidFramework(framework);
  const isIOS = isIOSFramework(framework);
  const isFlutter = isFlutterFramework(framework);
  const isReactNative = isReactNativeFramework(framework);

  let frameworkInstructions: string;

  if (isReactNative) {
    if (framework === "expo-router") {
      frameworkInstructions =
        `Analyze the following Expo Router files and extract every screen / route.

For Expo Router projects (file-based routing similar to Next.js App Router):
- Each file under app/ represents a route. The file path maps to the URL route (e.g. app/(tabs)/home.tsx -> /home, app/profile/[id].tsx -> /profile/[id]).
- _layout.tsx files define navigation structure using <Tabs>, <Stack>, or <Drawer> components.
- (group) directories (parenthesized names) are route groups — they do NOT appear in the URL path but organize navigation structure.
- [param] and [...catchAll] represent dynamic route segments.
- Files named index.tsx represent the default route for their directory.

Use the file-based route path as the "path" (e.g. "/", "/home", "/profile/[id]").
Set "componentFile" to the .tsx/.jsx file path.`;
    } else {
      frameworkInstructions =
        `Analyze the following React Navigation files and extract every screen / route.

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

    frameworkInstructions =
      `Analyze the following Flutter ${flutterLibLabel} files and extract every screen / route.

For Flutter projects, identify screens from:
- go_router: GoRoute(path: '...', builder: ...) and ShellRoute / StatefulShellRoute definitions
- auto_route: @RoutePage() annotated widgets and AutoRouter / AppRouter route lists
- Navigator 1.0: MaterialApp "routes" map entries and onGenerateRoute handler

Use the route path string as the "path" (e.g. "/home", "/user/:id").
For Navigator 1.0 named routes, use the route name (e.g. "/settings").
Set "componentFile" to the .dart file path containing the screen widget.`;
  } else if (framework === "gatsby") {
    frameworkInstructions =
      `Analyze the following Gatsby page files and extract every screen / route.

For Gatsby projects (file-based routing similar to Next.js Pages Router):
- Each file under src/pages/ represents a route. The file path maps to the URL route (e.g. src/pages/index.tsx -> /, src/pages/about.tsx -> /about, src/pages/blog/index.tsx -> /blog).
- Dynamic routes use curly brace notation: src/pages/{slug}.tsx -> /:slug, src/pages/users/{id}.tsx -> /users/:id.
- Files named index.tsx represent the default route for their directory.
- gatsby-node.js createPages API can generate additional dynamic pages — infer these from the source if visible.

Use the file-based route path as the "path" (e.g. "/", "/about", "/blog/:slug").
Set "componentFile" to the .tsx/.jsx/.ts/.js file path.`;
  } else if (isAstro) {
    frameworkInstructions =
      `Analyze the following Astro page files and extract every screen / route.

For Astro projects (file-based routing):
- Each file under src/pages/ represents a route. The file path maps to the URL route (e.g. src/pages/index.astro -> /, src/pages/about.astro -> /about, src/pages/blog/[slug].astro -> /blog/:slug).
- Supported page extensions: .astro, .md, .mdx, .tsx, .jsx, .ts, .js.
- Files named index.{astro,md,mdx} represent the default route for their directory.
- [param] brackets represent dynamic route segments: src/pages/blog/[slug].astro -> /blog/:slug.
- [...spread] represents catch-all routes: src/pages/[...path].astro -> /:path*.
- API routes under src/pages/api/ (e.g. src/pages/api/search.ts) are server endpoints, NOT screens — exclude them from the result.

Use the file-based route path as the "path" (e.g. "/", "/about", "/blog/:slug").
Set "componentFile" to the .astro/.md/.mdx/.tsx/.jsx file path.`;
  } else if (isPlainHtml) {
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
  } else if (isIOS) {
    frameworkInstructions =
      `Analyze the following iOS ${framework === "ios-swiftui" ? "SwiftUI" : "UIKit"} files and extract every screen / destination.

For iOS projects, identify screens from:
- Storyboard XML: <viewController> and <scene> elements with storyboardIdentifier attributes
- SwiftUI: Views used inside NavigationStack, NavigationView, NavigationSplitView, or TabView
- UIViewController subclasses: classes extending UIViewController or its subclasses
- Coordinator/Router pattern: navigation targets defined in Coordinator or Router classes

Use the Storyboard ID, SwiftUI navigation destination value, or class name as the "path" (e.g. "HomeView", "SettingsViewController", "profileDetail").
Set "componentFile" to the .swift, .m, or .storyboard file path.`;
  } else {
    frameworkInstructions =
      `Analyze the following ${framework} routing files and extract every screen / route.`;
  }

  const exampleComponentFile = isReactNative
    ? (framework === "expo-router"
        ? "app/(tabs)/home.tsx"
        : "src/screens/HomeScreen.tsx")
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
// Turn 3 — Transition extraction
// ---------------------------------------------------------------------------

export function buildTurn3Prompt(
  screens: { id: string; path: string }[],
  allComponentSources: { path: string; content: string }[],
  framework: FrameworkName,
): string {
  const screenList = screens.map((s) => `- ${s.id} (${s.path})`).join("\n");

  const filesSection = allComponentSources
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
            : framework === "gatsby"
              ? `"Link to", "navigate", "window.location"`
              : `"Link", "router.push", "window.location"`;

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
- "method": the code method used (e.g. ${methodExamples})
- "condition": (optional) any condition that must be true for the transition to occur

Only include transitions between the known screens listed above.
Return a JSON array. If no transitions are found, return an empty array [].

${filesSection}`;
}
