import { describe, expect, it } from "vitest";
import { render } from "react-email";
import { APP_PRODUCT_NAME, UPSTREAM_PRODUCT_NAME } from "@reactive-resume/utils/product";
import { ResetPasswordEmail, VerifyEmail, VerifyEmailChange } from "./auth";

const emails = () => [
	ResetPasswordEmail({ url: "https://example.com/reset" }),
	VerifyEmail({ url: "https://example.com/verify" }),
	VerifyEmailChange({
		url: "https://example.com/change",
		previousEmail: "dana@example.com",
		newEmail: "dana.reyes@example.com",
	}),
];

const PREVIEW_PATTERN = /<div[^>]*data-skip-in-text="true">([^<]*)</;

describe("authentication emails", () => {
	it.each([
		["reset password", () => ResetPasswordEmail({ url: "https://example.com/reset" })],
		["verify email", () => VerifyEmail({ url: "https://example.com/verify" })],
		[
			"change email",
			() =>
				VerifyEmailChange({
					url: "https://example.com/change",
					previousEmail: "dana@example.com",
					newEmail: "dana.reyes@example.com",
				}),
		],
	])("names this product, never the upstream project, on the %s email", async (_label, build) => {
		const html = await render(build());

		expect(html).toContain(APP_PRODUCT_NAME);
		expect(html).not.toContain(UPSTREAM_PRODUCT_NAME);
	});

	it("names this product in the subject preview, the logo alt and the signature", async () => {
		for (const email of emails()) {
			const html = await render(email);

			expect(html.match(PREVIEW_PATTERN)?.[1] ?? "").toContain(APP_PRODUCT_NAME);
			expect(html).toContain(`alt="${APP_PRODUCT_NAME}"`);
			expect(html).toContain(`>${APP_PRODUCT_NAME}</p>`);
		}
	});

	it("still credits the upstream project's author", async () => {
		const html = await render(VerifyEmail({ url: "https://example.com/verify" }));

		expect(html).toContain("A passion project by");
		expect(html).toContain("Amruth Pillai");
	});
});
