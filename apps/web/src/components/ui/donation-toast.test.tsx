// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://localhost:3000"}

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@lingui/core";
import Cookies from "js-cookie";

const state = vi.hoisted(() => ({
	runtime: "browser" as "desktop" | "browser",
	scopes: [] as unknown[],
}));

vi.mock("@tanstack/react-router", () => ({ useRouterState: () => "/" }));
vi.mock("@/libs/desktop-runtime", async (original) => {
	const actual = await original<typeof import("@/libs/desktop-runtime")>();
	return {
		...actual,
		detectionRuntime: (scope: unknown) => {
			state.scopes.push(scope);
			return state.runtime;
		},
	};
});

import { DonationToast } from "./donation-toast";

const FIVE_MINUTES = 5 * 60 * 1000;
const DISMISSED_COOKIE = "donation-toast-dismissed";

beforeEach(() => {
	state.runtime = "browser";
	state.scopes = [];
	vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	Cookies.remove(DISMISSED_COOKIE);
});

afterEach(() => {
	Cookies.remove(DISMISSED_COOKIE);
	vi.useRealTimers();
});

describe("on the web", () => {
	it("asks after five minutes and remembers a dismissal", async () => {
		render(<DonationToast />);

		await act(() => vi.advanceTimersByTimeAsync(FIVE_MINUTES));
		// In the DOM, not "visible": without LazyMotion features loaded, the entrance stays at opacity 0.
		expect(screen.getByText("Enjoying Fulei Resume?")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Maybe later" }));
		expect(Cookies.get(DISMISSED_COOKIE)).toBe("true");
	});

	it("reads the runtime from the window, not from a hard-coded guess", async () => {
		render(<DonationToast />);

		expect(state.scopes).toContain(globalThis);
	});

	it("stays away while the cookie is set", async () => {
		Cookies.set(DISMISSED_COOKIE, "true");
		render(<DonationToast />);

		await act(() => vi.advanceTimersByTimeAsync(FIVE_MINUTES));
		expect(screen.queryByText("Enjoying Fulei Resume?")).not.toBeInTheDocument();
	});
});

describe("on the desktop", () => {
	beforeEach(() => {
		state.runtime = "desktop";
	});

	it("never asks, however long the app stays open", async () => {
		render(<DonationToast />);

		await act(() => vi.advanceTimersByTimeAsync(FIVE_MINUTES * 12));
		expect(screen.queryByText("Enjoying Fulei Resume?")).not.toBeInTheDocument();
	});

	it("never writes the dismissal cookie", async () => {
		render(<DonationToast />);

		await act(() => vi.advanceTimersByTimeAsync(FIVE_MINUTES * 12));
		expect(Cookies.get(DISMISSED_COOKIE)).toBeUndefined();
	});

	it("ignores a cookie left behind by an older build", async () => {
		Cookies.set(DISMISSED_COOKIE, "false");
		render(<DonationToast />);

		await act(() => vi.advanceTimersByTimeAsync(FIVE_MINUTES * 2));
		expect(screen.queryByText("Enjoying Fulei Resume?")).not.toBeInTheDocument();
	});
});
