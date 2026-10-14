import { invoke } from "@tauri-apps/api/core";
import { createResumePdfBlob } from "@reactive-resume/pdf/browser";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";

const form = document.querySelector<HTMLFormElement>("#resume");
const status = document.querySelector<HTMLElement>("#status");

const escapeHtml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const bytesToBase64 = (bytes: Uint8Array) => {
	let binary = "";
	const size = 0x8000;
	for (let index = 0; index < bytes.length; index += size) {
		binary += String.fromCharCode(...bytes.subarray(index, index + size));
	}
	return btoa(binary);
};

const exportResume = async (name: string, summary: string) => {
	if (!status) return;
	status.textContent = "";
	const resume = structuredClone(defaultResumeData);
	resume.picture.hidden = true;
	resume.picture.url = "";
	resume.basics.name = name;
	resume.summary.content = `<p>${escapeHtml(summary)}</p>`;
	resume.metadata.layout.pages = [{ fullWidth: true, main: ["summary"], sidebar: [] }];
	const blob = await createResumePdfBlob({ data: resume });
	const pdfBase64 = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
	const path = await invoke<string>("save_resume_pdf", { pdfBase64 });
	status.textContent = `Exported ${path}`;
};

form?.addEventListener("submit", (event) => {
	event.preventDefault();
	if (!form || !status) return;
	const data = new FormData(form);
	void exportResume(String(data.get("name") ?? ""), String(data.get("summary") ?? "")).catch((error: unknown) => {
		status.textContent = error instanceof Error ? error.message : String(error);
	});
});
