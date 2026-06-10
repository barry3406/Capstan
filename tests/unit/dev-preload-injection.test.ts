// modulepreload 注入 —— 修「客户端运行时 ESM 瀑布」:
// HTML→client.js→entry.js→router→8 依赖→hydrate→vendor 共 ~7 层串行 RTT(跨境 2s RTT
// 时首屏 15s+)。SSR <head> 预声明全图 → 并行拉取,瀑布塌缩为 1 层。
// 关键契约:hydrate-current 的 preload URL 必须与 react client entry.ts 实际 import 的
// 串【完全一致】(?route=<encodeURIComponent(urlPattern)>),否则 preload 不命中、双倍下载。
import { describe, it, expect } from "bun:test";
import { injectManifest } from "../../packages/dev/src/server.js";
import type { RouteEntry } from "../../packages/dev/src/route-scanner.js";

const HTML = "<!doctype html><html><head><title>t</title></head><body><div>x</div></body></html>";

function makePageRoute(over: Partial<RouteEntry> = {}): RouteEntry {
  return {
    filePath: "app/routes/geo/products/[id]/workspace.page.tsx",
    urlPattern: "/geo/products/:id/workspace",
    type: "page",
    method: "GET",
    params: ["id"],
    layouts: [],
    middlewares: [],
    componentType: "client",
    ...over,
  } as RouteEntry;
}

describe("injectManifest — modulepreload 注入", () => {
  it("运行时全图进 <head>:client.js + entry/router 及其全部依赖", () => {
    const route = makePageRoute();
    const out = injectManifest(HTML, { routes: [route] } as never, route);
    const head = out.slice(0, out.indexOf("</head>") + 7);
    for (const f of [
      "/_capstan/client.js",
      "/_capstan/client/entry.js",
      "/_capstan/client/router.js",
      "/_capstan/client/manifest.js",
      "/_capstan/client/payload.js",
      "/_capstan/client/history.js",
      "/_capstan/client/transition.js",
    ]) {
      expect(head).toContain(`<link rel="modulepreload" href="${f}"/>`);
    }
  });

  it("需水合路由:hydrate-current 按【路由模式】键控 + vendor/shim 一并预载(与 entry.ts import 串一致)", () => {
    const route = makePageRoute();
    const out = injectManifest(HTML, { routes: [route] } as never, route);
    expect(out).toContain(
      `href="/_capstan/client/hydrate-current.js?route=${encodeURIComponent("/geo/products/:id/workspace")}"`,
    );
    expect(out).toMatch(/vendor\/bootstrap\.js\?v=/);
    expect(out).toContain("/_capstan/client/vendor/react.js");
    expect(out).toContain("/_capstan/client/vendor/react-dom-client.js");
    expect(out).toContain("/_capstan/client/vendor/react-jsx-runtime.js");
  });

  it("无当前路由(错误页等):只预载运行时,不预载 hydrate", () => {
    const route = makePageRoute();
    const out = injectManifest(HTML, { routes: [route] } as never, undefined);
    expect(out).toContain("/_capstan/client/entry.js");
    expect(out).not.toContain("hydrate-current.js");
  });

  it("manifest script 仍注入 </body> 前;无 </head> 时 preload 退化并入 body 注入", () => {
    const route = makePageRoute();
    const out = injectManifest(HTML, { routes: [route] } as never, route);
    expect(out.indexOf("__CAPSTAN_MANIFEST__")).toBeGreaterThan(out.indexOf("</head>"));
    const noHead = injectManifest("<body><p>x</p></body>", { routes: [route] } as never, route);
    expect(noHead).toContain("modulepreload"); // 仍注入(并到 body script 前)
    expect(noHead).toContain("__CAPSTAN_MANIFEST__");
  });
});
