import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serve } from "@hono/node-server";

const events = vi.hoisted(() => [] as string[]);
const appFetch = vi.hoisted(() => vi.fn());
const career = vi.hoisted(() => ({
	start: vi.fn(() => ({ stop: async () => {} })),
}));
const authGate = vi.hoisted(() => ({
	pending: null as Promise<void> | null,
}));
const serverEnv = vi.hoisted(() => ({
	SERVER_PORT: 0,
	STRICT_SCHEMA_CHECK: false,
}));
const doubles = vi.hoisted(() => ({
	detailed: false,
	migrate: vi.fn(async () => {
		events.push("migrations");
	}),
	verify: vi.fn(async () => {
		events.push("schema verification");
	}),
	reap: vi.fn(async () => {
		events.push("reap");
	}),
}));
vi.mock("pg", () => ({
	Pool: class {
		async connect() {
			return {
				query: async () => ({ rows: [] }),
				release() {},
			};
		}
		async end() {}
	},
}));
vi.mock("drizzle-orm/node-postgres/migrator", () => ({
	migrate: () => doubles.migrate(),
}));
vi.mock("./startup/schema-check", () => ({
	verifyMigratedSchema: () => doubles.verify(),
}));
vi.mock("@reactive-resume/api/features/agent/runs", () => ({
	reapStaleAgentRunsAtBoot: () => doubles.reap(),
}));
vi.mock("./startup/checks", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./startup/checks")>();
	return {
		...actual,
		runStartupChecks: async () => {
			if (!doubles.detailed) {
				await Promise.resolve();
				events.push("migrations complete");
				return;
			}
			await actual.runStartupChecks();
		},
	};
});
vi.mock("./http/app", () => {
	events.push("auth imported");
	return {
		createApp: () => {
			events.push("app created");
			return { fetch: appFetch };
		},
	};
});
vi.mock("@reactive-resume/auth/config", () => ({
	initializeAuth: async () => {
		if (authGate.pending) await authGate.pending;
		events.push("auth ready");
	},
}));
vi.mock("@hono/node-server", () => ({
	serve: vi.fn(() => {
		events.push("server listening");
	}),
}));
vi.mock("@reactive-resume/env/server", () => ({ env: serverEnv }));
// Scheduled career work has its own test; here it only has to stop when the server does.
vi.mock("./startup/career-scheduler", () => ({ startCareerScheduler: () => career.start() }));
afterEach(() => {
	doubles.detailed = false;
	doubles.migrate.mockReset();
	doubles.migrate.mockImplementation(async () => {
		events.push("migrations");
	});
	doubles.verify.mockReset();
	doubles.verify.mockImplementation(async () => {
		events.push("schema verification");
	});
	doubles.reap.mockReset();
	doubles.reap.mockImplementation(async () => {
		events.push("reap");
	});
	career.start.mockClear();
	authGate.pending = null;
	serverEnv.STRICT_SCHEMA_CHECK = false;
	delete process.env.DESKTOP;
	delete process.env.DESKTOP_DATA_DIR;
	vi.restoreAllMocks();
});

describe("server startup", () => {
	it("finishes migrations before importing auth and seeding OAuth resources", async () => {
		vi.spyOn(process, "on").mockReturnValue(process);
		vi.spyOn(process, "once").mockReturnValue(process);
		const entry = await import("./index");
		expect(events).toEqual([]);
		await entry.main();
		expect(events).toEqual(["migrations complete", "auth imported", "auth ready", "app created", "server listening"]);
	});

	it.each(["SIGTERM", "SIGINT"])("drains active requests before exiting on %s", async (signal) => {
		vi.spyOn(process, "on").mockReturnValue(process);
		const signals = vi.spyOn(process, "once").mockReturnValue(process);
		const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
		const started = Promise.withResolvers<void>();
		const finished = Promise.withResolvers<Response>();
		appFetch.mockImplementation(() => {
			started.resolve();
			return finished.promise;
		});
		const { serve: realServe } = await vi.importActual<typeof import("@hono/node-server")>("@hono/node-server");
		let server: ReturnType<typeof serve> | undefined;
		vi.mocked(serve).mockImplementationOnce((options, callback) => {
			server = realServe(options, callback);
			return server;
		});
		await (await import("./index")).main();
		if (!server) throw new Error("Server did not start");
		const runningServer = server;
		try {
			if (!server.listening) await once(server, "listening");
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Missing HTTP address");
			const url = `http://127.0.0.1:${address.port}`;
			const response = fetch(url);
			await started.promise;
			const shutdown = signals.mock.calls.find(([name]) => name === signal)?.[1];
			expect(shutdown).toBeTypeOf("function");
			const closed = once(server, "close");
			shutdown?.();
			shutdown?.();
			expect(exit).not.toHaveBeenCalled();
			await expect(fetch(url)).rejects.toThrow();
			finished.resolve(new Response("drained"));
			expect(await (await response).text()).toBe("drained");
			await closed;
			// Exit waits for the HTTP drain and the scheduler's stop together, a few microtasks after "close".
			await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(0));
		} finally {
			finished.resolve(new Response("drained"));
			await new Promise<void>((resolve) => runningServer.close(() => resolve()));
		}
	});

	it("writes the desktop migration identity after migrations and schema verification succeed", async () => {
		doubles.detailed = true;
		process.env.DESKTOP = "1";
		const dataDirectory = await mkdtemp(path.join(tmpdir(), "rr-desktop-"));
		process.env.DESKTOP_DATA_DIR = dataDirectory;
		vi.spyOn(process, "on").mockReturnValue(process);
		vi.spyOn(process, "once").mockReturnValue(process);
		vi.spyOn(console, "info").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		events.length = 0;
		try {
			await (await import("./index")).main();
			expect(events.indexOf("migrations")).toBeGreaterThanOrEqual(0);
			expect(events.indexOf("schema verification")).toBeGreaterThan(events.indexOf("migrations"));
			expect(await readFile(path.join(dataDirectory, "migration-identity"), "utf8")).not.toBe("");
		} finally {
			await rm(dataDirectory, { recursive: true, force: true });
		}
	});

	it("skips desktop migrations and schema verification when the migration identity matches", async () => {
		doubles.detailed = true;
		process.env.DESKTOP = "1";
		const dataDirectory = await mkdtemp(path.join(tmpdir(), "rr-desktop-"));
		process.env.DESKTOP_DATA_DIR = dataDirectory;
		vi.spyOn(process, "on").mockReturnValue(process);
		vi.spyOn(process, "once").mockReturnValue(process);
		vi.spyOn(console, "info").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		events.length = 0;
		try {
			const entry = await import("./index");
			await entry.main();
			const marker = await readFile(path.join(dataDirectory, "migration-identity"), "utf8");
			events.length = 0;
			await entry.main();
			expect(events).not.toContain("migrations");
			expect(events).not.toContain("schema verification");
			expect(events).toContain("auth ready");
			expect(events).toContain("server listening");
			expect(await readFile(path.join(dataDirectory, "migration-identity"), "utf8")).toBe(marker);
		} finally {
			await rm(dataDirectory, { recursive: true, force: true });
		}
	});

	it("reaps stale agent runs after the desktop server is listening without waiting to start the career scheduler", async () => {
		doubles.detailed = true;
		process.env.DESKTOP = "1";
		const pending = Promise.withResolvers<void>();
		doubles.reap.mockImplementationOnce(async () => {
			events.push("reap");
			await pending.promise;
		});
		const dataDirectory = await mkdtemp(path.join(tmpdir(), "rr-desktop-"));
		process.env.DESKTOP_DATA_DIR = dataDirectory;
		vi.spyOn(process, "on").mockReturnValue(process);
		vi.spyOn(process, "once").mockReturnValue(process);
		vi.spyOn(console, "info").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		events.length = 0;
		try {
			const running = (await import("./index")).main();
			await vi.waitFor(() => {
				expect(events.indexOf("server listening")).toBeGreaterThanOrEqual(0);
				expect(events.indexOf("reap")).toBeGreaterThan(events.indexOf("server listening"));
				expect(career.start).toHaveBeenCalled();
			});
			pending.resolve();
			await running;
		} finally {
			pending.resolve();
			await rm(dataDirectory, { recursive: true, force: true });
		}
	});

	it("keeps the desktop server listening when reaping stale agent runs fails", async () => {
		doubles.detailed = true;
		process.env.DESKTOP = "1";
		doubles.reap.mockImplementationOnce(async () => {
			events.push("reap");
			throw new Error("reap failed");
		});
		const dataDirectory = await mkdtemp(path.join(tmpdir(), "rr-desktop-"));
		process.env.DESKTOP_DATA_DIR = dataDirectory;
		vi.spyOn(process, "on").mockReturnValue(process);
		vi.spyOn(process, "once").mockReturnValue(process);
		const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
		vi.spyOn(console, "info").mockImplementation(() => {});
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		events.length = 0;
		try {
			await (await import("./index")).main();
			await vi.waitFor(() => {
				expect(events.indexOf("server listening")).toBeGreaterThanOrEqual(0);
				expect(events.indexOf("reap")).toBeGreaterThan(events.indexOf("server listening"));
			});
			expect(exit).not.toHaveBeenCalled();
			expect(logged).toHaveBeenCalledWith(
				"Failed to reap stale agent runs at boot",
				expect.objectContaining({ error: expect.any(Error) }),
			);
		} finally {
			await rm(dataDirectory, { recursive: true, force: true });
		}
	});

	it("does not listen until desktop auth initialization finishes", async () => {
		process.env.DESKTOP = "1";
		const pending = Promise.withResolvers<void>();
		authGate.pending = pending.promise;
		vi.spyOn(process, "on").mockReturnValue(process);
		vi.spyOn(process, "once").mockReturnValue(process);
		events.length = 0;
		try {
			const running = (await import("./index")).main();
			await vi.waitFor(() => expect(events).toContain("migrations complete"));
			expect(events).not.toContain("auth ready");
			expect(events).not.toContain("server listening");
			pending.resolve();
			await running;
			expect(events.indexOf("auth ready")).toBeLessThan(events.indexOf("server listening"));
		} finally {
			pending.resolve();
		}
	});

	it("runs desktop migrations when the identity does not match and then records the shipped identity", async () => {
		doubles.detailed = true;
		process.env.DESKTOP = "1";
		const dataDirectory = await mkdtemp(path.join(tmpdir(), "rr-desktop-"));
		const markerPath = path.join(dataDirectory, "migration-identity");
		process.env.DESKTOP_DATA_DIR = dataDirectory;
		await writeFile(markerPath, "stale-identity");
		vi.spyOn(process, "on").mockReturnValue(process);
		vi.spyOn(process, "once").mockReturnValue(process);
		vi.spyOn(console, "info").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		events.length = 0;
		try {
			const entry = await import("./index");
			await entry.main();
			expect(events.indexOf("schema verification")).toBeGreaterThan(events.indexOf("migrations"));
			const marker = await readFile(markerPath, "utf8");
			expect(marker).not.toBe("stale-identity");
			events.length = 0;
			await entry.main();
			expect(events).not.toContain("migrations");
			expect(events).not.toContain("schema verification");
			expect(await readFile(markerPath, "utf8")).toBe(marker);
		} finally {
			await rm(dataDirectory, { recursive: true, force: true });
		}
	});

	it("does not record a desktop migration identity when schema verification finds drift", async () => {
		doubles.detailed = true;
		process.env.DESKTOP = "1";
		serverEnv.STRICT_SCHEMA_CHECK = false;
		doubles.verify.mockImplementationOnce(async () => {
			events.push("schema verification");
			throw new Error('table "resume" missing');
		});
		const dataDirectory = await mkdtemp(path.join(tmpdir(), "rr-desktop-"));
		const markerPath = path.join(dataDirectory, "migration-identity");
		process.env.DESKTOP_DATA_DIR = dataDirectory;
		await writeFile(markerPath, "stale-identity");
		vi.spyOn(process, "on").mockReturnValue(process);
		vi.spyOn(process, "once").mockReturnValue(process);
		vi.spyOn(console, "info").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		events.length = 0;
		try {
			await (await import("./index")).main();
			expect(events).toContain("migrations");
			expect(events).toContain("schema verification");
			expect(events).toContain("server listening");
			expect(await readFile(markerPath, "utf8")).toBe("stale-identity");
		} finally {
			await rm(dataDirectory, { recursive: true, force: true });
		}
	});

	it("migrates, verifies, and reaps before listening without touching a desktop migration identity", async () => {
		doubles.detailed = true;
		delete process.env.DESKTOP;
		const dataDirectory = await mkdtemp(path.join(tmpdir(), "rr-desktop-"));
		const markerPath = path.join(dataDirectory, "migration-identity");
		process.env.DESKTOP_DATA_DIR = dataDirectory;
		await writeFile(markerPath, "leave-me");
		vi.spyOn(process, "on").mockReturnValue(process);
		vi.spyOn(process, "once").mockReturnValue(process);
		vi.spyOn(console, "info").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		events.length = 0;
		try {
			await (await import("./index")).main();
			expect(events.indexOf("migrations")).toBeGreaterThanOrEqual(0);
			expect(events.indexOf("schema verification")).toBeGreaterThan(events.indexOf("migrations"));
			expect(events.indexOf("reap")).toBeGreaterThan(events.indexOf("schema verification"));
			expect(events.indexOf("auth ready")).toBeGreaterThan(events.indexOf("reap"));
			expect(events.indexOf("server listening")).toBeGreaterThan(events.indexOf("auth ready"));
			expect(await readFile(markerPath, "utf8")).toBe("leave-me");
		} finally {
			await rm(dataDirectory, { recursive: true, force: true });
		}
	});
});
