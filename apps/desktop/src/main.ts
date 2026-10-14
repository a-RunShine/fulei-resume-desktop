import { invoke } from "@tauri-apps/api/core";
import { createResumePdfBlob } from "@reactive-resume/pdf/browser";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";

const form = document.querySelector<HTMLFormElement>("#resume");
const providerForm = document.querySelector<HTMLFormElement>("#provider");
const status = document.querySelector<HTMLElement>("#status");
const providerStatus = document.querySelector<HTMLElement>("#provider-status");
const reply = document.querySelector<HTMLElement>("#reply");
const askButton = document.querySelector<HTMLButtonElement>("#ask");

const escapeHtml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const bytesToBase64 = (bytes: Uint8Array) => {
	let binary = "";
	const size = 0x8000;
	for (let index = 0; index < bytes.length; index += size) {
		binary += String.fromCharCode(...bytes.subarray(index, index + size));
	}
	return btoa(binary);
};

const fieldValue = (source: HTMLFormElement | null, field: string) => {
	if (!source) return "";
	return String(new FormData(source).get(field) ?? "");
};

const resumeDocument = (resumeName: string, resumeSummary: string) => {
	const resume = structuredClone(defaultResumeData);
	resume.picture.hidden = true;
	resume.picture.url = "";
	resume.basics.name = resumeName;
	resume.summary.content = `<p>${escapeHtml(resumeSummary)}</p>`;
	resume.metadata.layout.pages = [{ fullWidth: true, main: ["summary"], sidebar: [] }];
	return resume;
};

const currentResume = () => resumeDocument(fieldValue(form, "name"), fieldValue(form, "summary"));

const messageFrom = (error: unknown) => (error instanceof Error ? error.message : String(error));

const persistResume = async () => {
	try {
		await invoke("save_resume", { resume: JSON.stringify(currentResume()) });
	} catch {
		return;
	}
};

const exportResume = async (resumeName: string, resumeSummary: string) => {
	if (!status) return;
	status.textContent = "";
	await persistResume();
	const blob = await createResumePdfBlob({ data: resumeDocument(resumeName, resumeSummary) });
	const pdfBase64 = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
	const path = await invoke<string>("save_resume_pdf", { pdfBase64 });
	status.textContent = `Exported ${path}`;
};

form?.addEventListener("input", () => {
	void persistResume();
});

form?.addEventListener("submit", (event) => {
	event.preventDefault();
	if (!form || !status) return;
	const data = new FormData(form);
	void exportResume(String(data.get("name") ?? ""), String(data.get("summary") ?? "")).catch((error: unknown) => {
		status.textContent = messageFrom(error);
	});
});

const applyProvider = async () => {
	const settings = await invoke<{ baseUrl: string; model: string }>("load_provider");
	const baseUrl = providerForm?.querySelector<HTMLInputElement>("[name=baseUrl]");
	const model = providerForm?.querySelector<HTMLInputElement>("[name=model]");
	if (baseUrl && baseUrl.value === "") baseUrl.value = settings.baseUrl;
	if (model && model.value === "") model.value = settings.model;
};

void applyProvider().catch((error: unknown) => {
	if (providerStatus) providerStatus.textContent = messageFrom(error);
});

providerForm?.addEventListener("submit", (event) => {
	event.preventDefault();
	if (!providerForm || !providerStatus) return;
	const value = (field: string) => providerForm.querySelector<HTMLInputElement>(`[name="${field}"]`)?.value ?? "";
	providerStatus.textContent = "";
	void invoke("save_provider", {
		baseUrl: value("baseUrl"),
		model: value("model"),
		apiKey: value("apiKey"),
	})
		.then(() => {
			providerStatus.textContent = "Provider saved";
			const field = providerForm.querySelector<HTMLInputElement>('[name="apiKey"]');
			if (field) field.value = "";
		})
		.catch((error: unknown) => {
			providerStatus.textContent = messageFrom(error);
		});
});

let asking = false;

askButton?.addEventListener("click", () => {
	if (asking || !reply) return;
	asking = true;
	reply.textContent = "";
	void invoke<string>("ask_assistant", { resume: JSON.stringify(currentResume()) })
		.then((text) => {
			reply.textContent = text;
		})
		.catch((error: unknown) => {
			reply.textContent = messageFrom(error);
		})
		.finally(() => {
			asking = false;
		});
});
