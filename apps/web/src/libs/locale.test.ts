import { describe, expect, it } from "vitest";
import { defaultLocale, desktopDefaultLocale } from "@reactive-resume/utils/locale";
import { defaultLocaleFor, getLocale } from "./locale";

type Write = { name: string; value: string; attributes: unknown };

const cookies = (stored: string | undefined) => {
	const writes: Write[] = [];
	return {
		writes,
		get: (name: string) => (name === "locale" ? stored : undefined),
		set: (name: string, value: string, attributes?: unknown) => {
			writes.push({ name, value, attributes });
		},
	};
};

describe("the locale a runtime falls back to", () => {
	it("is Simplified Chinese on the desktop", () => {
		expect(defaultLocaleFor("desktop")).toBe(desktopDefaultLocale);
	});

	it("stays the upstream default in a browser", () => {
		expect(defaultLocaleFor("browser")).toBe(defaultLocale);
	});

	it("can load the locale it names", () => {
		expect(desktopDefaultLocale).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
	});
});

describe("getLocale precedence", () => {
	it("uses the desktop default when no preference is recorded", () => {
		expect(getLocale({ scope: "desktop", cookie: cookies(undefined), search: "" })).toBe("zh-CN");
	});

	it("keeps a language the person chose over the default", () => {
		expect(getLocale({ scope: "desktop", cookie: cookies("de-DE"), search: "" })).toBe("de-DE");
	});

	it("stores an explicit locale address for a year so it survives a restart", () => {
		const cookie = cookies(undefined);

		expect(getLocale({ scope: "desktop", cookie, search: "?locale=ja-JP" })).toBe("ja-JP");

		const [write] = cookie.writes;
		if (!write) throw new Error("the address did not store the locale");
		expect(write.name).toBe("locale");
		expect(write.value).toBe("ja-JP");
		expect(write.attributes).toMatchObject({ expires: 365, path: "/", sameSite: "lax" });
	});

	it("does not rewrite the cookie when the language came from one", () => {
		const cookie = cookies("de-DE");

		getLocale({ scope: "desktop", cookie, search: "" });

		expect(cookie.writes).toEqual([]);
	});

	it("falls back to the upstream default in a browser with no preference", () => {
		expect(getLocale({ scope: "browser", cookie: cookies(undefined), search: "" })).toBe(defaultLocale);
	});

	it("ignores a value that is not a supported locale", () => {
		expect(getLocale({ scope: "desktop", cookie: cookies("xx-YY"), search: "" })).toBe("zh-CN");
		expect(getLocale({ scope: "browser", cookie: cookies("xx-YY"), search: "" })).toBe(defaultLocale);
	});
});
