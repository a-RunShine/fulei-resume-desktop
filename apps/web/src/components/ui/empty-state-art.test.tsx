// @vitest-environment happy-dom

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyStateArt, type EmptyStateArtVariant } from "./empty-state-art";

const variants: EmptyStateArtVariant[] = ["assistant", "career", "applications"];

describe("EmptyStateArt", () => {
	it.each(variants)("renders an svg for the %s empty state", (variant) => {
		const { container } = render(<EmptyStateArt variant={variant} size={96} />);
		const svg = container.querySelector("svg");
		expect(svg).not.toBeNull();
		expect(svg?.getAttribute("viewBox")).toBe("0 0 120 120");
		expect(svg?.getAttribute("aria-hidden")).toBe("true");
	});

	it.each(variants)("draws the %s art with theme tokens rather than fixed colours", (variant) => {
		const { container } = render(<EmptyStateArt variant={variant} size={96} />);
		const markup = container.innerHTML;

		expect(markup).toContain("var(--ink-2)");
		expect(markup).toContain("var(--accent)");
		expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
	});

	it.each(variants)("renders the %s art at the requested size", (variant) => {
		const { container } = render(<EmptyStateArt variant={variant} size={64} />);
		const svg = container.querySelector("svg");
		expect(svg?.getAttribute("width")).toBe("64");
		expect(svg?.getAttribute("height")).toBe("64");
	});
});
