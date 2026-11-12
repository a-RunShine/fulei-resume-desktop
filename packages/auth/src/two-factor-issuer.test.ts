import { describe, expect, it } from "vitest";
import { DESKTOP_PRODUCT_NAME, UPSTREAM_PRODUCT_NAME } from "@reactive-resume/utils/product";
import { auth } from "./config";

describe("two-factor authenticator label", () => {
	it("labels the authenticator entry after this product", () => {
		const issuer = auth.options.plugins?.find((plugin) => plugin.id === "two-factor")?.options;

		expect(issuer).toMatchObject({ issuer: DESKTOP_PRODUCT_NAME });
	});

	it("does not hand an authenticator the upstream project's name", () => {
		const issuer = auth.options.plugins?.find((plugin) => plugin.id === "two-factor")?.options as
			| { issuer?: string }
			| undefined;

		expect(issuer?.issuer).not.toBe(UPSTREAM_PRODUCT_NAME);
	});
});
