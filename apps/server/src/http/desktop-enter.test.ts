import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	signInEmail: vi.fn(),
	signUpEmail: vi.fn(),
	importResume: vi.fn(),
}));

vi.mock("@reactive-resume/auth/config", () => ({
	auth: { api: { signInEmail: mocks.signInEmail, signUpEmail: mocks.signUpEmail } },
}));

vi.mock("@reactive-resume/env/server", () => ({ env: { APP_URL: "http://127.0.0.1:47821" } }));

import { handleDesktopEnter } from "./desktop-enter";

const request = () => new Request("http://127.0.0.1:47821/desktop/enter");

const signedIn = () => {
	const headers = new Headers();
	headers.append("set-cookie", "better-auth.session_token=token; Path=/; HttpOnly");
	return new Response(null, { status: 200, headers });
};

describe("handleDesktopEnter", () => {
	beforeEach(() => {
		process.env.DESKTOP = "1";
		mocks.signInEmail.mockReset();
		mocks.signUpEmail.mockReset();
	});

	it("redirects to the dashboard once the local account is signed in", async () => {
		mocks.signInEmail.mockResolvedValue(signedIn());

		const response = await handleDesktopEnter(request());

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("http://127.0.0.1:47821/dashboard");
		expect(response.headers.getSetCookie().length).toBeGreaterThan(0);
	});

	it("creates the local account when it does not exist yet", async () => {
		mocks.signInEmail.mockResolvedValue(new Response(null, { status: 401 }));
		mocks.signUpEmail.mockResolvedValue(signedIn());

		const response = await handleDesktopEnter(request());

		expect(response.status).toBe(302);
		expect(mocks.signUpEmail).toHaveBeenCalledOnce();
	});

	it("explains the failure instead of bouncing the window back to a login form", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.signInEmail.mockResolvedValue(new Response("user not found", { status: 401 }));
		mocks.signUpEmail.mockResolvedValue(new Response("sign-up rejected", { status: 403 }));

		const response = await handleDesktopEnter(request());
		const body = await response.text();

		expect(response.status).toBe(500);
		expect(response.headers.get("location")).toBeNull();
		expect(body).toContain("Fulei Resume could not start");
		expect(body).toContain("user not found");
		expect(body).toContain("sign-up rejected");
	});

	it("escapes the failure detail so the reason cannot inject markup", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.signInEmail.mockResolvedValue(new Response("<script>alert(1)</script>", { status: 401 }));
		mocks.signUpEmail.mockResolvedValue(new Response("nope", { status: 403 }));

		const response = await handleDesktopEnter(request());
		const body = await response.text();

		expect(body).not.toContain("<script>alert(1)</script>");
		expect(body).toContain("&lt;script&gt;");
	});

	it("stays out of the way on a web deployment", async () => {
		process.env.DESKTOP = "0";

		const response = await handleDesktopEnter(request());

		expect(response.status).toBe(404);
		expect(mocks.signInEmail).not.toHaveBeenCalled();
	});
});
