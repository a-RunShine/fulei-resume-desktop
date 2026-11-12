import { describe, expect, it } from "vitest";
import { render } from "react-email";
import { DESKTOP_PRODUCT_NAME, UPSTREAM_PRODUCT_NAME } from "@reactive-resume/utils/product";
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
	it("names this product in the subject preview of every email", async () => {
		for (const email of emails()) {
			const html = await render(email);
			const preview = html.match(PREVIEW_PATTERN)?.[1] ?? "";

			expect(preview).toContain(DESKTOP_PRODUCT_NAME);
			expect(preview).not.toContain(UPSTREAM_PRODUCT_NAME);
		}
	});

	it("names this product on the logo and the footer signature", async () => {
		for (const email of emails()) {
			const html = await render(email);

			expect(html).toContain(`alt="${DESKTOP_PRODUCT_NAME}"`);
			expect(html).toContain(`>${DESKTOP_PRODUCT_NAME}</p>`);
		}
	});

	it("still credits the upstream project it is built on", async () => {
		const html = await render(VerifyEmail({ url: "https://example.com/verify" }));

		expect(html).toContain(`Built on`);
		expect(html).toContain(`>${UPSTREAM_PRODUCT_NAME}</a>`);
		expect(html).toContain("Amruth Pillai");
	});
});
