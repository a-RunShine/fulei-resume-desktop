import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { env } from "@reactive-resume/env/server";
import { getLocalDataDirectory } from "@reactive-resume/utils/monorepo.node";
import { verifyMigratedSchema } from "./schema-check";

function resolveFromCurrentModule(relativePath: string) {
	return fileURLToPath(new URL(relativePath, import.meta.url));
}

function resolveWorkspaceFolder(folderName: string): string {
	let dir = resolveFromCurrentModule(".");

	while (dir !== path.dirname(dir)) {
		const candidate = path.join(dir, folderName);
		if (existsSync(candidate)) return candidate;
		dir = path.dirname(dir);
	}

	throw new Error(`Could not locate ${folderName} folder relative to ${resolveFromCurrentModule(".")}`);
}

const migrationIdentityFile = "migration-identity";

function isMissingFile(error: unknown) {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function shippedMigrationIdentity(migrationsFolder: string) {
	const names = (await fs.readdir(migrationsFolder)).sort();
	const hash = createHash("sha256");
	for (const name of names) {
		try {
			const sql = await fs.readFile(path.join(migrationsFolder, name, "migration.sql"));
			hash.update(name);
			hash.update("\0");
			hash.update(sql);
			hash.update("\0");
		} catch (error) {
			if (!isMissingFile(error)) throw error;
		}
	}
	return hash.digest("hex");
}

function desktopDataDirectory() {
	if (process.env.DESKTOP !== "1") return;
	return process.env.DESKTOP_DATA_DIR;
}

async function desktopMigrationIdentityMatches(migrationsFolder: string) {
	const dataDirectory = desktopDataDirectory();
	if (!dataDirectory) return false;
	try {
		const current = await fs.readFile(path.join(dataDirectory, migrationIdentityFile), "utf8");
		return current === (await shippedMigrationIdentity(migrationsFolder));
	} catch (error) {
		if (isMissingFile(error)) return false;
		throw error;
	}
}

async function writeDesktopMigrationIdentity(migrationsFolder: string) {
	const dataDirectory = desktopDataDirectory();
	if (!dataDirectory) return;
	await fs.writeFile(path.join(dataDirectory, migrationIdentityFile), await shippedMigrationIdentity(migrationsFolder));
}

export async function runDatabaseMigrations() {
	const migrationsFolder = resolveWorkspaceFolder("migrations");
	if (await desktopMigrationIdentityMatches(migrationsFolder)) return;

	console.info("Running database migrations...");

	const pool = new Pool({
		connectionString: env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL,
		max: 1,
		connectionTimeoutMillis: 10_000,
	});

	let schemaVerified = false;
	try {
		const client = await pool.connect();
		try {
			await client.query("SELECT pg_advisory_lock(721830451)");
			const db = drizzle({ client });
			try {
				await migrate(db, { migrationsFolder });
				console.info("Database migrations completed");
			} catch (error) {
				console.error("Database migrations failed", { error });
				throw error;
			}

			// Post-migration verification is not a migration failure, so it gets its own log
			// message. A drifted schema still lets the server boot; STRICT_SCHEMA_CHECK=true
			// makes the drift fatal instead.
			try {
				await verifyMigratedSchema(client);
				schemaVerified = true;
			} catch (error) {
				console.error("Database schema verification failed", { error });
				if (env.STRICT_SCHEMA_CHECK) throw error;
				console.error(
					"Continuing with a drifted database schema; set STRICT_SCHEMA_CHECK=true to refuse startup instead.",
				);
			}
		} finally {
			try {
				await client.query("SELECT pg_advisory_unlock(721830451)");
			} finally {
				client.release();
			}
		}
	} finally {
		await pool.end();
	}

	if (schemaVerified) await writeDesktopMigrationIdentity(migrationsFolder);
}

async function validateLocalStoragePath() {
	if (env.STORAGE_BACKEND !== "local") return;

	const dataDirectory = getLocalDataDirectory(env.LOCAL_STORAGE_PATH);
	console.info(`Validating local storage path: ${dataDirectory}`);

	try {
		await fs.mkdir(dataDirectory, { recursive: true });
		await fs.access(dataDirectory, constants.R_OK | constants.W_OK);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		console.error(
			`Local storage path is not writable: ${dataDirectory}\n` +
				`  ${message}\n` +
				"Set LOCAL_STORAGE_PATH to a writable directory or fix permissions on the existing path.",
		);
		throw error;
	}
}

async function reapStaleAgentRuns() {
	try {
		const { reapStaleAgentRunsAtBoot } = await import("@reactive-resume/api/features/agent/runs");
		await reapStaleAgentRunsAtBoot();
	} catch (error) {
		// A reap failure must not block serving traffic; stuck runs also heal lazily on access.
		console.error("Failed to reap stale agent runs at boot", { error });
	}
}

export function reapStaleAgentRunsAfterHealthy() {
	return reapStaleAgentRuns();
}

export async function runStartupChecks() {
	await runDatabaseMigrations();
	await validateLocalStoragePath();
	if (process.env.DESKTOP === "1") return;
	await reapStaleAgentRuns();
}
