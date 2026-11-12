import { describe, expect, it } from "vitest";
import { APP_PRODUCT_NAME } from "@reactive-resume/utils/product";
import { auth } from "./config";

const twoFactorIssuer = () => {
	const plugin = auth.options.plugins?.find((candidate) => candidate.id === "two-factor");
	const options = plugin?.options as { issuer?: string } | undefined;
	if (!options?.issuer) throw new Error("the two-factor plugin sets no issuer");
	return options.issuer;
};

describe("two-factor authenticator label", () => {
	it("labels the authenticator entry after this product", () => {
		expect(twoFactorIssuer()).toBe(APP_PRODUCT_NAME);
	});
});
