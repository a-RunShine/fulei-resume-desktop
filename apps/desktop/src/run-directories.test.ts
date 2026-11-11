import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	createRunDirectory,
	finishRunDirectories,
	planRunDirectorySweep,
	removeDirectoryBestEffort,
	runDirectoryName,
	sweepRunDirectories,
} from "./run-directories";

const fixtures: string[] = [];

const fixtureRoot = () => {
	const root = mkdtempSync(join(tmpdir(), "rr-run-directories-"));
	fixtures.push(root);
	return root;
};

type RunTreeEntry = {
	name: string;
	modifiedMs: number;
};

const fixtureRuns = (entries: readonly RunTreeEntry[]) => {
	const root = fixtureRoot();
	const runsRoot = join(root, "runs");
	mkdirSync(runsRoot, { recursive: true });
	for (const entry of entries) {
		const directory = join(runsRoot, entry.name);
		mkdirSync(directory, { recursive: true });
		utimesSync(directory, new Date(entry.modifiedMs), new Date(entry.modifiedMs));
	}
	return { root, runsRoot };
};

afterEach(() => {
	for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("plans the keeps and removals for a directory listing", () => {
	const plan = planRunDirectorySweep(
		[
			{ name: "old-1", modifiedMs: 100 },
			{ name: "mid-2", modifiedMs: 200 },
			{ name: "new-4", modifiedMs: 400 },
			{ name: "newer-5", modifiedMs: 500 },
			{ name: "mid-3", modifiedMs: 300 },
		],
		{ keep: 3, preserve: [] },
	);

	expect(plan.keep).toEqual(["newer-5", "new-4", "mid-3"]);
	expect(plan.remove).toEqual(["mid-2", "old-1"]);
});

it("plans no removal while fewer entries than the keep count exist", () => {
	const plan = planRunDirectorySweep(
		[
			{ name: "old-1", modifiedMs: 100 },
			{ name: "new-2", modifiedMs: 200 },
		],
		{ keep: 3, preserve: [] },
	);

	expect(plan.keep).toEqual(["new-2", "old-1"]);
	expect(plan.remove).toEqual([]);
});

it("keeps preserved entries even when they fall outside the most recent ones", () => {
	const plan = planRunDirectorySweep(
		[
			{ name: "old-1", modifiedMs: 100 },
			{ name: "mid-2", modifiedMs: 200 },
			{ name: "new-4", modifiedMs: 400 },
			{ name: "newer-5", modifiedMs: 500 },
			{ name: "mid-3", modifiedMs: 300 },
		],
		{ keep: 3, preserve: ["old-1"] },
	);

	expect(plan.keep).toEqual(["newer-5", "new-4", "mid-3", "old-1"]);
	expect(plan.remove).toEqual(["mid-2"]);
});

it("removes a run directory with everything under it", async () => {
	const root = fixtureRoot();
	const directory = join(root, "probe", "nested");
	mkdirSync(join(directory, "cache"), { recursive: true });
	writeFileSync(join(directory, "cache", "data.bin"), "leftover");
	const removed = await removeDirectoryBestEffort(directory);
	expect(removed).toBe(true);
	expect(existsSync(directory)).toBe(false);
});

it("logs a removal failure after retrying instead of throwing or hiding it", async () => {
	const attempts: number[] = [];
	const warnings: string[] = [];
	const removed = await removeDirectoryBestEffort("locked\\run\\directory", {
		attempts: 3,
		retryDelayMs: 1,
		remove: () => {
			attempts.push(1);
			throw new Error("the process cannot access the file");
		},
		warn: (message) => {
			warnings.push(message);
		},
	});
	expect(removed).toBe(false);
	expect(attempts).toHaveLength(3);
	expect(warnings).toHaveLength(1);
	expect(warnings[0]).toContain("locked\\run\\directory");
	expect(warnings[0]).toContain("the process cannot access the file");
});

it("sweeps run directories down to the three most recent ones", async () => {
	const { root, runsRoot } = fixtureRuns([
		{ name: "run-a-4101", modifiedMs: 1_000 },
		{ name: "run-b-4102", modifiedMs: 2_000 },
		{ name: "run-c-4103", modifiedMs: 3_000 },
		{ name: "run-d-4104", modifiedMs: 4_000 },
		{ name: "run-e-4105", modifiedMs: 5_000 },
		{ name: "run-f-4106", modifiedMs: 6_000 },
	]);
	await sweepRunDirectories(root, { alive: () => false });
	expect(readdirSync(runsRoot).sort()).toEqual(["run-d-4104", "run-e-4105", "run-f-4106"]);
});

it("leaves runtime and server-deploy alone however old they are", async () => {
	const { root, runsRoot } = fixtureRuns([
		{ name: "run-a-4101", modifiedMs: 1_000 },
		{ name: "run-b-4102", modifiedMs: 2_000 },
		{ name: "run-c-4103", modifiedMs: 3_000 },
		{ name: "run-d-4104", modifiedMs: 4_000 },
	]);
	for (const name of ["runtime", "server-deploy"]) {
		const directory = join(root, name);
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "payload.bin"), "shared cache");
		utimesSync(join(directory, "payload.bin"), new Date(500), new Date(500));
	}
	await sweepRunDirectories(root, { alive: () => false });
	expect(existsSync(join(root, "runtime", "payload.bin"))).toBe(true);
	expect(existsSync(join(root, "server-deploy", "payload.bin"))).toBe(true);
	expect(readdirSync(runsRoot).sort()).toEqual(["run-b-4102", "run-c-4103", "run-d-4104"]);
});

it("keeps the run directory of a process that is still running", async () => {
	const { root, runsRoot } = fixtureRuns([
		{ name: runDirectoryName("probe", 2001), modifiedMs: 1_000 },
		{ name: "run-b-3102", modifiedMs: 2_000 },
		{ name: "run-c-3103", modifiedMs: 3_000 },
		{ name: "run-d-3104", modifiedMs: 4_000 },
		{ name: "run-e-3105", modifiedMs: 5_000 },
	]);
	await sweepRunDirectories(root, { alive: (pid) => pid === 2001 });
	expect(readdirSync(runsRoot).sort()).toEqual(["probe-2001", "run-c-3103", "run-d-3104", "run-e-3105"]);
});

it("removes the run directories a passing run created", async () => {
	const root = fixtureRoot();
	const first = createRunDirectory(join(root, "runs"), "probe-a-4201");
	const second = createRunDirectory(join(root, "runs"), "probe-b-4202");
	await finishRunDirectories("pass");
	expect(existsSync(first)).toBe(false);
	expect(existsSync(second)).toBe(false);
});

it("leaves the run directories a failed run created on disk for inspection", async () => {
	const root = fixtureRoot();
	const failed = createRunDirectory(join(root, "runs"), "probe-fail-4301");
	await finishRunDirectories("fail");
	expect(existsSync(failed)).toBe(true);

	const passed = createRunDirectory(join(root, "runs"), "probe-pass-4302");
	await finishRunDirectories("pass");
	expect(existsSync(passed)).toBe(false);
	expect(existsSync(failed)).toBe(true);
});
