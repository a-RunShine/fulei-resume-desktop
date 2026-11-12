import type { ResumeData } from "@reactive-resume/schema/resume/data";
import { beforeEach, describe, expect, it } from "vitest";
import { i18n } from "@lingui/core";
import { Route as publicResumeRoute } from "./$username/$slug";
import { Route as rootRoute } from "./__root";
import { Route as atsCheckerRoute } from "./_home/ats-checker";
import { Route as homeRoute } from "./_home/index";

type RouteHead = (context: { loaderData: unknown }) => { meta: { title?: string }[] };

const titleOf = (route: { options: { head?: unknown } }, loaderData?: unknown) => {
	const head = route.options.head as RouteHead | undefined;
	if (!head) throw new Error("route sets no head");
	const title = head({ loaderData }).meta.find((entry) => entry.title)?.title;
	if (!title) throw new Error("route head sets no title");
	return title;
};

const resumeData = {
	basics: { name: "Dana Reyes", headline: "Staff Engineer" },
	summary: { content: "Ten years of shipping." },
	metadata: { template: "default" },
} as unknown as ResumeData;

const sharedResume = {
	id: "resume-1",
	name: "Dana Reyes CV",
	slug: "dana-reyes",
	data: resumeData,
	showDownloadButtons: true,
};

describe("route titles", () => {
	beforeEach(() => {
		i18n.activate("en");
	});

	it("falls back to the product name so app pages never inherit a marketing title", () => {
		expect(titleOf(rootRoute)).toBe("Fulei Resume");
	});

	it("keeps the upstream titles on the homepage and the ATS checker", () => {
		expect(titleOf(homeRoute)).toBe("Reactive Resume — A free and open-source resume builder");
		expect(titleOf(atsCheckerRoute)).toBe("Free ATS resume checker — Reactive Resume");
	});

	it("keeps the product name on the shared resume's success branch", () => {
		expect(titleOf(publicResumeRoute, { resume: sharedResume })).toBe("Dana Reyes - Fulei Resume");
	});

	it("falls back to the product name alone when the shared resume did not load", () => {
		expect(titleOf(publicResumeRoute)).toBe("Fulei Resume");
	});

	it("keeps the upstream name on the root resume's unavailable state", () => {
		expect(titleOf(homeRoute, { root: { status: "unavailable" } })).toBe("Reactive Resume");
	});

	it("keeps the upstream name on a public root resume", () => {
		const loaderData = { root: { status: "public", username: "dana", slug: "dana-reyes", resume: sharedResume } };
		expect(titleOf(homeRoute, loaderData)).toBe("Dana Reyes - Reactive Resume");
	});
});
