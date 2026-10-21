import { expect, it } from "vitest";
import { desktopServerDependencyStaysExternal, desktopServerShouldBundleDependency } from "./desktop-bundle";

it("leaves PGlite and native files outside the desktop server bundle", () => {
	expect(desktopServerDependencyStaysExternal("hono")).toBe(false);
	expect(desktopServerDependencyStaysExternal("@hono/node-server")).toBe(false);
	expect(desktopServerDependencyStaysExternal("@reactive-resume/schema")).toBe(false);
	expect(desktopServerDependencyStaysExternal("@electric-sql/pglite-socket")).toBe(false);
	expect(desktopServerDependencyStaysExternal("@electric-sql/pglite")).toBe(true);
	expect(desktopServerDependencyStaysExternal("@electric-sql/pglite/dist/pglite.wasm")).toBe(true);
	expect(desktopServerDependencyStaysExternal("sharp")).toBe(true);
	expect(desktopServerDependencyStaysExternal("css-tree")).toBe(true);
	expect(desktopServerDependencyStaysExternal("mdn-data")).toBe(true);
	expect(desktopServerDependencyStaysExternal("@img/sharp-win32-x64")).toBe(true);
	expect(desktopServerDependencyStaysExternal("@img/sharp-win32-x64/sharp.node")).toBe(true);
});

it("bundles ordinary desktop server dependencies", () => {
	expect(desktopServerShouldBundleDependency("hono")).toBe(true);
	expect(desktopServerShouldBundleDependency("@hono/node-server")).toBe(true);
	expect(desktopServerShouldBundleDependency("@reactive-resume/schema")).toBe(true);
	expect(desktopServerShouldBundleDependency("@electric-sql/pglite-socket")).toBe(true);
	expect(desktopServerShouldBundleDependency("node:fs")).toBe(false);
	expect(desktopServerShouldBundleDependency("@electric-sql/pglite")).toBe(false);
	expect(desktopServerShouldBundleDependency("sharp")).toBe(false);
	expect(desktopServerShouldBundleDependency("css-tree")).toBe(false);
	expect(desktopServerShouldBundleDependency("@img/sharp-win32-x64")).toBe(false);
});
