import { expect, it } from "vitest";
import { desktopServerDependencyStaysExternal } from "./desktop-bundle";

it("leaves PGlite and native files outside the desktop server bundle", () => {
	expect(desktopServerDependencyStaysExternal("hono")).toBe(false);
	expect(desktopServerDependencyStaysExternal("@hono/node-server")).toBe(false);
	expect(desktopServerDependencyStaysExternal("@reactive-resume/schema")).toBe(false);
	expect(desktopServerDependencyStaysExternal("@electric-sql/pglite-socket")).toBe(false);
	expect(desktopServerDependencyStaysExternal("@electric-sql/pglite")).toBe(true);
	expect(desktopServerDependencyStaysExternal("@electric-sql/pglite/dist/pglite.wasm")).toBe(true);
	expect(desktopServerDependencyStaysExternal("sharp")).toBe(true);
	expect(desktopServerDependencyStaysExternal("@img/sharp-win32-x64")).toBe(true);
	expect(desktopServerDependencyStaysExternal("@img/sharp-win32-x64/sharp.node")).toBe(true);
});
