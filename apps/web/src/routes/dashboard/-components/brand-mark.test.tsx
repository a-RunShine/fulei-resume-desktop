// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BRAND_NAME, BrandMark } from "./brand-mark";

vi.mock("@reactive-resume/ui/components/brand-icon", () => ({
	BrandIcon: ({ variant }: { variant?: string }) => <img alt="" data-variant={variant} />,
}));

afterEach(cleanup);

describe("BrandMark", () => {
	it("shows the product name beside the mark", () => {
		render(<BrandMark />);

		expect(screen.getByText(BRAND_NAME)).toBeInTheDocument();
		expect(BRAND_NAME).toBe("Fulei Resume");
	});

	it("never renders the upstream product name", () => {
		const { container } = render(<BrandMark />);

		expect(container.textContent).not.toContain("Reactive Resume");
	});

	it("stays out of the tab order because it is no longer a link", () => {
		const { container } = render(<BrandMark />);

		expect(container.querySelector("a")).toBeNull();
		expect(screen.queryByRole("link")).toBeNull();
	});

	it("drops the wordmark in the collapsed rail while keeping the mark", () => {
		const { container } = render(<BrandMark showName={false} />);

		expect(container.textContent).toBe("");
		expect(container.querySelector("img")).not.toBeNull();
	});
});
