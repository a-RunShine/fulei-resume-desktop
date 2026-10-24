// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";

const mocks = vi.hoisted(() => ({
	save: vi.fn(),
	anchor: vi.fn(),
	create: vi.fn(),
}));

vi.mock("@/features/resume/export/save-file", () => ({ downloadFile: mocks.save }));
vi.mock("@reactive-resume/utils/file", () => ({ downloadWithAnchor: mocks.anchor, generateFilename: vi.fn() }));
vi.mock("@/features/resume/export/use-resume-export", () => ({
	createExportFile: mocks.create,
	getDefaultFileName: () => "Sam-Taylor",
	sanitizeFileName: (value: string) => value,
}));
vi.mock("@/features/resume/builder/draft", () => ({
	useCurrentResume: () => ({ id: "resume-1", name: "Sam Taylor", data: { basics: { name: "Sam Taylor" } } }),
}));
vi.mock("@/features/resume/editor/check/use-check", () => ({ useOpenIssueCount: () => 0 }));
vi.mock("@/features/applications/queries", () => ({ applicationsListQueryOptions: () => ({ queryKey: ["apps"] }) }));
vi.mock("@/libs/orpc/client", () => ({
	client: { coverLetters: { getById: vi.fn() } },
	orpc: { applications: { list: { queryOptions: () => ({ queryKey: ["apps"] }) } } },
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: [] }) }));
vi.mock("@reactive-resume/ui/components/toast", () => ({ toast: { add: vi.fn(), close: vi.fn() } }));

import { DownloadTab } from "./download-tab";

const renderTab = () =>
	render(
		<I18nProvider i18n={i18n}>
			<DownloadTab onReview={() => undefined} />
		</I18nProvider>,
	);

const submit = async (format: string) => {
	renderTab();
	if (format !== "pdf") fireEvent.click(screen.getByRole("radio", { name: new RegExp(format, "i") }));
	fireEvent.click(await screen.findByRole("button", { name: /download (pdf|word|markdown|json)/i }));
};

describe("the share panel download", () => {
	beforeEach(() => {
		i18n.loadAndActivate({ locale: "en-US", messages: {} });
		mocks.save.mockReset();
		mocks.anchor.mockReset();
		mocks.create.mockReset();
		mocks.create.mockResolvedValue(new Blob(["payload"]));
		mocks.save.mockResolvedValue(undefined);
	});

	afterEach(cleanup);

	it.each([
		["pdf", ".pdf"],
		["docx", ".docx"],
		["markdown", ".md"],
		["json", ".json"],
	])("saves the %s file through the shared save path", async (format, extension) => {
		await submit(format);

		await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
		expect(mocks.save.mock.calls[0]?.[0]).toMatchObject({ suggestedName: `Sam-Taylor${extension}` });
	});

	it("never falls back to a bare anchor download", async () => {
		await submit("pdf");

		await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
		expect(mocks.anchor).not.toHaveBeenCalled();
	});

	it("reports a failed save instead of silently dropping it", async () => {
		const { toast } = await import("@reactive-resume/ui/components/toast");
		mocks.save.mockRejectedValue(new Error("disk full"));

		await submit("pdf");

		await waitFor(() =>
			expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({ type: "error", description: "disk full" })),
		);
	});
});
