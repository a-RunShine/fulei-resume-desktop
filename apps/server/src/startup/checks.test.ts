import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { Pool, type PoolClient } from "pg";
import { runDatabaseMigrations } from "./checks";
import { isDatabaseMigrated } from "./migration-state";
import { verifyMigratedSchema } from "./schema-check";

const serverEnv = vi.hoisted(() => ({
	DATABASE_URL: "",
	STRICT_SCHEMA_CHECK: false,
}));

const migrateCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("@reactive-resume/env/server", () => ({ env: serverEnv }));

vi.mock("drizzle-orm/node-postgres/migrator", async (importOriginal) => {
	const actual = await importOriginal<typeof import("drizzle-orm/node-postgres/migrator")>();
	return {
		migrate: (...args: Parameters<typeof actual.migrate>) => {
			migrateCalls.count += 1;
			return actual.migrate(...args);
		},
	};
});

type TestDatabase = {
	dataDirectory: string;
	databaseUrl: string;
	connect: () => Promise<PoolClient>;
	close: () => Promise<void>;
};

async function startTestDatabase(): Promise<TestDatabase> {
	const dataDirectory = await mkdtemp(path.join(tmpdir(), "rr-checks-"));
	const database = new PGlite(path.join(dataDirectory, "pglite"));
	const socket = new PGLiteSocketServer({ db: database, host: "127.0.0.1", port: 0, maxConnections: 20 });
	await socket.start();
	const connection = socket.getServerConn();
	const databaseUrl = connection.startsWith("postgres")
		? connection
		: `postgresql://postgres:postgres@${connection}/postgres`;
	const pool = new Pool({ connectionString: databaseUrl, max: 1 });

	return {
		dataDirectory,
		databaseUrl,
		connect: () => pool.connect(),
		close: async () => {
			await pool.end();
			await socket.stop();
			await new Promise((resolve) => setTimeout(resolve, 50));
			await database.close();
			await rm(dataDirectory, { recursive: true, force: true });
		},
	};
}

function resolveMigrationsFolder(): string {
	let dir = fileURLToPath(new URL(".", import.meta.url));

	while (dir !== path.dirname(dir)) {
		const candidate = path.join(dir, "migrations");
		if (existsSync(candidate)) return candidate;
		dir = path.dirname(dir);
	}

	throw new Error("Could not locate the migrations folder");
}

async function legacyDesktopMigrationIdentity(migrationsFolder: string) {
	const names = (await readdir(migrationsFolder)).sort();
	const hash = createHash("sha256");
	for (const name of names) {
		try {
			const sql = await readFile(path.join(migrationsFolder, name, "migration.sql"));
			hash.update(name);
			hash.update("\0");
			hash.update(sql);
			hash.update("\0");
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
	}
	return hash.digest("hex");
}

afterEach(() => {
	vi.restoreAllMocks();
	migrateCalls.count = 0;
	serverEnv.DATABASE_URL = "";
	serverEnv.STRICT_SCHEMA_CHECK = false;
	delete process.env.DESKTOP;
	delete process.env.DESKTOP_DATA_DIR;
});

describe("runDatabaseMigrations", () => {
	it("rebuilds an empty database even when a matching desktop migration identity file survives", async () => {
		const database = await startTestDatabase();
		process.env.DESKTOP = "1";
		process.env.DESKTOP_DATA_DIR = database.dataDirectory;
		serverEnv.DATABASE_URL = database.databaseUrl;
		const migrationsFolder = resolveMigrationsFolder();
		await writeFile(
			path.join(database.dataDirectory, "migration-identity"),
			await legacyDesktopMigrationIdentity(migrationsFolder),
		);
		vi.spyOn(console, "info").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await runDatabaseMigrations();
			const client = await database.connect();
			try {
				const rebuilt = await client.query("select to_regclass('public.oauth_resource') as relation");
				expect(rebuilt.rows[0]?.relation).toBeTruthy();
				const user = await client.query("select to_regclass('public.user') as relation");
				expect(user.rows[0]?.relation).toBeTruthy();
			} finally {
				client.release();
			}
		} finally {
			await database.close();
		}
	}, 60_000);

	it("does not migrate again on an already migrated database", async () => {
		const database = await startTestDatabase();
		serverEnv.DATABASE_URL = database.databaseUrl;
		vi.spyOn(console, "info").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await runDatabaseMigrations();
			const client = await database.connect();
			let ledgerBefore: unknown[];
			try {
				ledgerBefore = (
					await client.query("select id, hash, created_at, name from drizzle.__drizzle_migrations order by id")
				).rows;
			} finally {
				client.release();
			}

			migrateCalls.count = 0;
			await runDatabaseMigrations();
			expect(migrateCalls.count).toBe(0);

			const second = await database.connect();
			try {
				const ledgerAfter = (
					await second.query("select id, hash, created_at, name from drizzle.__drizzle_migrations order by id")
				).rows;
				expect(ledgerAfter).toEqual(ledgerBefore);
			} finally {
				second.release();
			}
		} finally {
			await database.close();
		}
	}, 60_000);

	it("reports a table dropped out from under a complete migration ledger instead of skipping", async () => {
		const database = await startTestDatabase();
		process.env.DESKTOP = "1";
		process.env.DESKTOP_DATA_DIR = database.dataDirectory;
		serverEnv.DATABASE_URL = database.databaseUrl;
		const migrationsFolder = resolveMigrationsFolder();
		await writeFile(
			path.join(database.dataDirectory, "migration-identity"),
			await legacyDesktopMigrationIdentity(migrationsFolder),
		);
		vi.spyOn(console, "info").mockImplementation(() => {});
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await runDatabaseMigrations();
			const client = await database.connect();
			try {
				await client.query('drop table "oauth_resource" cascade');
			} finally {
				client.release();
			}

			await runDatabaseMigrations();
			const failure = logged.mock.calls.find(([message]) => message === "Database schema verification failed");
			if (!failure) throw new Error("Expected a schema verification failure to be logged");
			const error = (failure[1] as { error: Error }).error;
			expect(error.message).toContain('table "oauth_resource"');
		} finally {
			await database.close();
		}
	}, 60_000);

	it("refuses to continue on a damaged schema when STRICT_SCHEMA_CHECK is set", async () => {
		const database = await startTestDatabase();
		process.env.DESKTOP = "1";
		process.env.DESKTOP_DATA_DIR = database.dataDirectory;
		serverEnv.DATABASE_URL = database.databaseUrl;
		serverEnv.STRICT_SCHEMA_CHECK = true;
		const migrationsFolder = resolveMigrationsFolder();
		await writeFile(
			path.join(database.dataDirectory, "migration-identity"),
			await legacyDesktopMigrationIdentity(migrationsFolder),
		);
		vi.spyOn(console, "info").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await runDatabaseMigrations();
			const client = await database.connect();
			try {
				await client.query('drop table "oauth_resource" cascade');
			} finally {
				client.release();
			}

			await expect(runDatabaseMigrations()).rejects.toThrow(/oauth_resource/);
		} finally {
			await database.close();
		}
	}, 60_000);
});

describe("isDatabaseMigrated", () => {
	it("reports a fully migrated database as migrated", async () => {
		const database = await startTestDatabase();
		serverEnv.DATABASE_URL = database.databaseUrl;
		vi.spyOn(console, "info").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await runDatabaseMigrations();
			const client = await database.connect();
			try {
				await expect(isDatabaseMigrated(client, resolveMigrationsFolder())).resolves.toBe(true);
			} finally {
				client.release();
			}
		} finally {
			await database.close();
		}
	}, 60_000);

	it("reports an empty database as not migrated", async () => {
		const database = await startTestDatabase();
		serverEnv.DATABASE_URL = database.databaseUrl;

		try {
			const client = await database.connect();
			try {
				await expect(isDatabaseMigrated(client, resolveMigrationsFolder())).resolves.toBe(false);
			} finally {
				client.release();
			}
		} finally {
			await database.close();
		}
	}, 60_000);

	it("reports a migration missing from the ledger as not migrated even when the schema verifies", async () => {
		const database = await startTestDatabase();
		serverEnv.DATABASE_URL = database.databaseUrl;
		vi.spyOn(console, "info").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await runDatabaseMigrations();
			const client = await database.connect();
			try {
				await client.query(
					"delete from drizzle.__drizzle_migrations where id = (select max(id) from drizzle.__drizzle_migrations)",
				);
				await expect(verifyMigratedSchema(client)).resolves.toBeUndefined();
				await expect(isDatabaseMigrated(client, resolveMigrationsFolder())).resolves.toBe(false);
			} finally {
				client.release();
			}
		} finally {
			await database.close();
		}
	}, 60_000);

	it("reports a database missing a table as not migrated even when the ledger is complete", async () => {
		const database = await startTestDatabase();
		serverEnv.DATABASE_URL = database.databaseUrl;
		vi.spyOn(console, "info").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await runDatabaseMigrations();
			const client = await database.connect();
			try {
				await client.query('drop table "oauth_resource" cascade');
				await expect(isDatabaseMigrated(client, resolveMigrationsFolder())).resolves.toBe(false);
			} finally {
				client.release();
			}
		} finally {
			await database.close();
		}
	}, 60_000);
});
