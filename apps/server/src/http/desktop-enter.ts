import { existsSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { auth } from "@reactive-resume/auth/config";
import { env } from "@reactive-resume/env/server";

const email = "local@example.com";
const password = "local-desktop-password-32";
const username = "local";

const account = {
	name: "Local",
	email,
	password,
	username,
	displayUsername: username,
};

async function signInOrUp(request: Request): Promise<Response> {
	const headers = new Headers(request.headers);
	headers.set("origin", env.APP_URL);
	const signedIn = await auth.api.signInEmail({
		body: { email, password },
		headers,
		asResponse: true,
	});
	if (signedIn.ok) return signedIn;
	return auth.api.signUpEmail({
		body: account,
		headers,
		asResponse: true,
	});
}

function cookieHeader(response: Response) {
	const cookies = response.headers.getSetCookie?.() ?? [];
	if (cookies.length > 0) return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
	return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function importLegacyResumes(cookie: string) {
	const source = process.env.DESKTOP_SQLITE;
	const marker = process.env.DESKTOP_DATA_DIR ? `${process.env.DESKTOP_DATA_DIR}/sqlite-imported` : "";
	if (!source || !marker || existsSync(marker) || !existsSync(source)) return;
	const database = new DatabaseSync(source, { readOnly: true });
	const rows = database.prepare("SELECT payload FROM resume").all() as { payload: string }[];
	database.close();
	for (const row of rows) {
		const payload = JSON.parse(row.payload) as { data?: unknown };
		if (!payload.data) continue;
		await fetch(new URL("/api/rpc/resume/import", env.APP_URL), {
			method: "POST",
			headers: { "content-type": "application/json", cookie, origin: env.APP_URL },
			body: JSON.stringify({ json: { data: payload.data } }),
		});
	}
	writeFileSync(marker, "ok");
}

export async function handleDesktopEnter(request: Request): Promise<Response> {
	if (process.env.DESKTOP !== "1") return new Response(null, { status: 404 });
	const signed = await signInOrUp(request);
	if (!signed.ok || signed.headers.getSetCookie().length === 0) {
		console.error("[desktop] sign-in failed", signed.status, await signed.clone().text());
	}
	const cookie = cookieHeader(signed);
	if (cookie) await importLegacyResumes(cookie);
	const headers = new Headers();
	for (const cookieValue of signed.headers.getSetCookie?.() ?? []) headers.append("set-cookie", cookieValue);
	headers.set("location", new URL("/dashboard", env.APP_URL).toString());
	headers.set("cache-control", "no-store");
	return new Response(null, { status: 302, headers });
}
