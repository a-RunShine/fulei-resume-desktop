import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export type RunDirectoryEntry = {
	name: string;
	modifiedMs: number;
};

export type SweepPlan = {
	keep: string[];
	remove: string[];
};

export type RemoveDirectoryOptions = {
	attempts?: number;
	retryDelayMs?: number;
	remove?: (directory: string) => void | Promise<void>;
	warn?: (message: string) => void;
};

export const removeDirectoryBestEffort = async (
	directory: string,
	options: RemoveDirectoryOptions = {},
): Promise<boolean> => {
	const attempts = options.attempts ?? 5;
	const retryDelayMs = options.retryDelayMs ?? 300;
	const remove = options.remove ?? ((target: string) => rmSync(target, { recursive: true, force: true }));
	const warn = options.warn ?? ((message: string) => console.warn(message));
	let failure = "";
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			await remove(directory);
			return true;
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
			if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
		}
	}
	warn(`[window-runtime] could not remove run directory ${directory}: ${failure}`);
	return false;
};

export const planRunDirectorySweep = (
	entries: readonly RunDirectoryEntry[],
	options: { keep: number; preserve: readonly string[] },
): SweepPlan => {
	const ranked = [...entries].sort(
		(left, right) => right.modifiedMs - left.modifiedMs || left.name.localeCompare(right.name),
	);
	const kept = new Set(ranked.slice(0, Math.max(options.keep, 0)).map((entry) => entry.name));
	for (const name of options.preserve) kept.add(name);
	return {
		keep: ranked.filter((entry) => kept.has(entry.name)).map((entry) => entry.name),
		remove: ranked.filter((entry) => !kept.has(entry.name)).map((entry) => entry.name),
	};
};

export const runDirectoryName = (name: string, pid: number) => `${name}-${pid}`;

let createdRunDirectories: string[] = [];

export const createRunDirectory = (runsRoot: string, name: string) => {
	const directory = join(runsRoot, name);
	rmSync(directory, { recursive: true, force: true });
	mkdirSync(directory, { recursive: true });
	createdRunDirectories.push(directory);
	return directory;
};

export const finishRunDirectories = async (outcome: "pass" | "fail", options: RemoveDirectoryOptions = {}) => {
	const directories = createdRunDirectories;
	createdRunDirectories = [];
	if (outcome === "fail") return;
	for (const directory of directories) await removeDirectoryBestEffort(directory, options);
};

const runDirectoryPid = (name: string) => {
	const match = /-(\d+)$/.exec(name);
	if (match?.[1] === undefined) return undefined;
	return Number(match[1]);
};

const processAlive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

export type SweepOptions = {
	keep?: number;
	alive?: (pid: number) => boolean;
};

export const sweepRunDirectories = async (runRoot: string, options: SweepOptions = {}) => {
	const runsRoot = join(runRoot, "runs");
	const alive = options.alive ?? processAlive;
	try {
		if (!existsSync(runsRoot)) return;
		const entries: RunDirectoryEntry[] = readdirSync(runsRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => ({ name: entry.name, modifiedMs: statSync(join(runsRoot, entry.name)).mtimeMs }));
		const preserve = entries
			.filter((entry) => {
				const pid = runDirectoryPid(entry.name);
				return pid !== undefined && alive(pid);
			})
			.map((entry) => entry.name);
		const plan = planRunDirectorySweep(entries, { keep: options.keep ?? 3, preserve });
		for (const name of plan.remove) await removeDirectoryBestEffort(join(runsRoot, name));
	} catch (error) {
		console.warn(
			`[window-runtime] could not sweep run directories under ${runsRoot}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
};
