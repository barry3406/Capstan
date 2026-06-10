import { getManifest, matchRoute } from "./manifest.js";
import { initRouter, getRouter } from "./router.js";
import { isClientNavigableHref } from "./href.js";

/**
 * Bootstrap the client-side router.
 *
 * Called once when the page loads.  Reads the route manifest from
 * `window.__CAPSTAN_MANIFEST__`, initialises the router singleton,
 * and sets up global `<a>` click delegation so that *all* internal
 * links benefit from SPA navigation — even those rendered outside
 * React (e.g. server-rendered HTML from morphdom).
 */
export function bootstrapClient(): void {
  const manifest = getManifest();
  if (!manifest) {
    // No manifest injected — running in a context without client routing
    // (e.g. statically rendered page or test environment).
    return;
  }

  const router = initRouter(manifest);
  const currentMatch = matchRoute(manifest, window.location.pathname);

  if (currentMatch?.route.needsHydration) {
    // 以【路由模式】为键(?route=/x/:id)而非完整路径:同一路由的不同参数共享同一 URL →
    // 浏览器缓存可命中;且与服务端 SSR <head> 里 modulepreload 的 URL 完全一致(preload 命中)。
    void import(
      `/_capstan/client/hydrate-current.js?route=${encodeURIComponent(currentMatch.route.urlPattern)}`,
    );
  }

  // Global click delegation — intercept all <a> clicks that target
  // internal routes.  This catches links rendered by morphdom that
  // don't go through the React <Link> component.
  document.addEventListener("click", (e: MouseEvent) => {
    // Only handle left clicks without modifiers
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    if (e.defaultPrevented) return;

    // Walk up from the click target to find the nearest <a>
    const anchor = (e.target as Element).closest("a");
    if (!anchor) return;

    const href = anchor.getAttribute("href");
    if (!href) return;
    const targetUrl = new URL(href, window.location.href);
    const targetMatch = matchRoute(manifest, targetUrl.pathname);
    // Skip external, hash-only, and download links
    if (
      !isClientNavigableHref(href) ||
      anchor.hasAttribute("download") ||
      anchor.getAttribute("target") === "_blank"
    ) {
      return;
    }

    // Skip links with data-capstan-external attribute (opt-out)
    if (anchor.hasAttribute("data-capstan-external")) return;
    if (currentMatch?.route.needsHydration || targetMatch?.route.needsHydration) return;

    const scrollStoreKey = anchor.getAttribute("data-capstan-scroll-store");
    if (scrollStoreKey && typeof window !== "undefined") {
      try {
        window.sessionStorage.setItem(
          scrollStoreKey,
          JSON.stringify({ x: window.scrollX, y: window.scrollY, href }),
        );
      } catch {
        // Ignore storage errors.
      }
    }

    e.preventDefault();

    // Safety timeout — if client navigation doesn't complete within 5s,
    // fall back to a full browser navigation so the user never gets stuck.
    const fallbackTimer = setTimeout(() => {
      window.location.href = href;
    }, 5000);

    router.navigate(href, {
      replace: anchor.hasAttribute("data-capstan-replace"),
      scroll: anchor.getAttribute("data-capstan-scroll") !== "false",
    }).finally(() => {
      clearTimeout(fallbackTimer);
    });
  }, true);
}
