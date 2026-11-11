import fs from "node:fs/promises";
import path from "node:path";
import { verifyMigratedSchema, type SchemaQueryable } from "./schema-check";

type LedgerQueryable = {
	query(text: string, values?: unknown[]): Promise<{ rows: { name: string | null }[] }>;
};

type MigrationStateQueryable = SchemaQueryable & LedgerQueryable;

async function shippedMigrationNames(migrationsFolder: string) {
	const names: string[] = [];

	for (const name of (await fs.readdir(migrationsFolder)).sort()) {
		try {
			await fs.access(path.join(migrationsFolder, name, "migration.sql"));
			names.push(name);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
	}

	return names;
}

async function hasPendingMigrations(queryable: LedgerQueryable, migrationsFolder: string) {
	const shipped = await shippedMigrationNames(migrationsFolder);

	let applied: Set<string>;
	try {
		const result = await queryable.query("select name from drizzle.__drizzle_migrations");
		applied = new Set(result.rows.map((row) => row.name).filter((name): name is string => name !== null));
	} catch {
		return true;
	}

	return shipped.some((name) => !applied.has(name));
}

export async function isDatabaseMigrated(queryable: MigrationStateQueryable, migrationsFolder: string) {
	if (await hasPendingMigrations(queryable, migrationsFolder)) return false;

	try {
		await verifyMigratedSchema(queryable);
		return true;
	} catch {
		return false;
	}
}
