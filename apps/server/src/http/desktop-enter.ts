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

type Attempt = { response: Response; detail: string };

async function describeFailure(response: Response) {
	return (
		await response
			.clone()
			.text()
			.catch(() => "")
	)
		.trim()
		.slice(0, 240);
}

async function signInOrUp(request: Request): Promise<{ signed: Response | null; failures: Attempt[] }> {
	const headers = new Headers(request.headers);
	headers.set("origin", env.APP_URL);
	const failures: Attempt[] = [];
	const signedIn = await auth.api.signInEmail({
		body: { email, password },
		headers,
		asResponse: true,
	});
	if (signedIn.ok) return { signed: signedIn, failures };
	failures.push({ response: signedIn, detail: await describeFailure(signedIn) });
	const signedUp = await auth.api.signUpEmail({
		body: account,
		headers,
		asResponse: true,
	});
	if (signedUp.ok) return { signed: signedUp, failures };
	failures.push({ response: signedUp, detail: await describeFailure(signedUp) });
	return { signed: null, failures };
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
	const { signed, failures } = await signInOrUp(request);
	const cookie = signed ? cookieHeader(signed) : "";
	if (!signed || !cookie) {
		for (const failure of failures) console.error("[desktop] sign-in failed", failure.response.status, failure.detail);
		return desktopFailure(failures);
	}
	await importLegacyResumes(cookie);
	const headers = new Headers();
	for (const cookieValue of signed.headers.getSetCookie?.() ?? []) headers.append("set-cookie", cookieValue);
	headers.set("location", new URL("/dashboard", env.APP_URL).toString());
	headers.set("cache-control", "no-store");
	return new Response(null, { status: 302, headers });
}

function desktopFailure(failures: Attempt[]): Response {
	const details = failures
		.map((failure) => `sign-in returned ${failure.response.status}: ${failure.detail || "no detail"}`)
		.join("\n");
	const body = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Fulei Resume</title>
<style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#F8F7F3;color:#1F2937;font-family:"Segoe UI","Microsoft YaHei",sans-serif}.box{max-width:38rem;padding:2rem;text-align:center}h1{font-size:1.15rem;margin:0 0 .75rem}p{margin:0 0 .5rem;line-height:1.6}code{display:block;margin-top:1rem;padding:.75rem;border-radius:.5rem;background:#EFEDE8;color:#9a3412;font-size:.8rem;word-break:break-word;text-align:left;white-space:pre-wrap}</style>
</head><body><div class="box"><h1>Fulei Resume could not start</h1>
<p>The app could not sign in to its local account, so it stopped instead of asking you to log in.</p>
<p>Close the app and open it again. If this keeps happening, send the details below.</p><code>${escapeHtml(details || "sign-in failed without a reason")}</code></div></body></html>`;
	return new Response(body, {
		status: 500,
		headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
	});
}

function escapeHtml(value: string) {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
