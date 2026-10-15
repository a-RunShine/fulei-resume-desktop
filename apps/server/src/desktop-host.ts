import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const dataDirectory = process.env.DESKTOP_DATA_DIR;
if (!dataDirectory) throw new Error("DESKTOP_DATA_DIR is required");
mkdirSync(dataDirectory, { recursive: true });

const database = new PGlite(join(dataDirectory, "pglite"));
const socket = new PGLiteSocketServer({
	db: database,
	host: "127.0.0.1",
	port: 0,
	maxConnections: 20,
});
await socket.start();
const connection = socket.getServerConn();
const databaseUrl = connection.startsWith("postgres")
	? connection
	: `postgresql://postgres:postgres@${connection}/postgres`;

process.env.NODE_ENV = "production";
process.env.PORT = process.env.PORT ?? "47821";
process.env.APP_URL = `http://127.0.0.1:${process.env.PORT}`;
process.env.DATABASE_URL = databaseUrl;
process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "desktop-auth-secret-do-not-use-in-production-01";
process.env.ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET ?? "desktop-encryption-secret-32-characters";
process.env.STORAGE_BACKEND = "local";
process.env.LOCAL_STORAGE_PATH = join(dataDirectory, "files");
process.env.FLAG_DISABLE_API_RATE_LIMIT = "true";
process.env.STRICT_SCHEMA_CHECK = "false";
process.env.DESKTOP = "1";
mkdirSync(process.env.LOCAL_STORAGE_PATH, { recursive: true });

const { main } = await import("./index.ts");
await main();
