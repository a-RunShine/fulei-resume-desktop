import type { ExperienceItem, ResumeData, SkillItem } from "@reactive-resume/schema/resume/data";
import type { Template } from "@reactive-resume/schema/templates";
import { invoke } from "@tauri-apps/api/core";
import { createResumePdfBlob } from "@reactive-resume/pdf/browser";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { templateSchema } from "@reactive-resume/schema/templates";

const status = document.querySelector<HTMLElement>("#status");
const persist = document.querySelector<HTMLElement>("#persist");
const resumeList = document.querySelector<HTMLUListElement>("#resumes");
const newResumeButton = document.querySelector<HTMLButtonElement>("#new-resume");
const editor = document.querySelector<HTMLElement>("#editor");
const titleInput = document.querySelector<HTMLInputElement>("#title");
const deleteResumeButton = document.querySelector<HTMLButtonElement>("#delete-resume");
const nameInput = document.querySelector<HTMLInputElement>("#basics-name");
const summaryInput = document.querySelector<HTMLTextAreaElement>("#summary");
const addItemButton = document.querySelector<HTMLButtonElement>("#add-item");
const templateSelect = document.querySelector<HTMLSelectElement>("#template");
const paperSelect = document.querySelector<HTMLSelectElement>("#paper");
const experienceItem = document.querySelector<HTMLElement>("#experience-item");
const skillInput = document.querySelector<HTMLInputElement>("#skill");
const companyInput = document.querySelector<HTMLInputElement>("#company");
const positionInput = document.querySelector<HTMLInputElement>("#position");
const exportButton = document.querySelector<HTMLButtonElement>("#export-pdf");

type ResumeListItem = {
	id: string;
	name: string;
};

type ResumeRecord = ResumeListItem & {
	document: ResumeData;
};

let openResumeId: string | undefined;
let resumeDocument: ResumeData | undefined;
let saveGeneration = 0;
let saveQueue: Promise<void> = Promise.resolve();

const showError = (error: unknown) => {
	if (!status) return;
	status.textContent = error instanceof Error ? error.message : String(error);
};

const escapeHtml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const summaryText = (html: string) => {
	const match = /^<p>([\s\S]*)<\/p>$/.exec(html);
	const inner = match?.[1] ?? html;
	return inner.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
};

const blankResume = (): ResumeData => {
	const resume = structuredClone(defaultResumeData);
	resume.picture.hidden = true;
	resume.picture.url = "";
	return resume;
};

const skillNamed = (name: string): SkillItem => ({
	id: crypto.randomUUID(),
	hidden: false,
	icon: "",
	iconColor: "",
	name,
	proficiency: "",
	level: 0,
	keywords: [],
});

const emptyExperience = (): ExperienceItem => ({
	id: crypto.randomUUID(),
	hidden: false,
	company: "",
	position: "",
	location: "",
	period: "",
	website: { url: "", label: "", inlineLink: false },
	roles: [],
	description: "",
});

const showDocument = (title: string) => {
	if (!resumeDocument) return;
	if (titleInput) titleInput.value = title;
	if (nameInput) nameInput.value = resumeDocument.basics.name;
	if (summaryInput) summaryInput.value = summaryText(resumeDocument.summary.content);
	if (templateSelect) templateSelect.value = resumeDocument.metadata.template;
	if (paperSelect) {
		paperSelect.value = resumeDocument.metadata.page.format === "letter" ? "letter" : "a4";
	}
	if (skillInput) skillInput.value = resumeDocument.sections.skills.items[0]?.name ?? "";
	const item = resumeDocument.sections.experience.items[0];
	if (item) {
		experienceItem?.removeAttribute("hidden");
		if (companyInput) companyInput.value = item.company;
		if (positionInput) positionInput.value = item.position;
	} else {
		experienceItem?.setAttribute("hidden", "");
		if (companyInput) companyInput.value = "";
		if (positionInput) positionInput.value = "";
	}
	editor?.removeAttribute("hidden");
};

const saveDocument = () => {
	if (!openResumeId || !resumeDocument) return;
	const id = openResumeId;
	const documentSnapshot = structuredClone(resumeDocument);
	const generation = ++saveGeneration;
	if (persist) persist.textContent = "Saving";
	saveQueue = saveQueue
		.then(async () => {
			if (generation !== saveGeneration) return;
			await invoke("save_resume", { id, document: documentSnapshot });
			if (generation === saveGeneration && persist) persist.textContent = "Saved";
		})
		.catch(showError);
};

const renderResumes = (resumes: ResumeListItem[]) => {
	if (!resumeList) return;
	resumeList.replaceChildren();
	for (const resume of resumes) {
		const item = document.createElement("li");
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = resume.name;
		button.addEventListener("click", () => {
			void loadResume(resume.id).catch(showError);
		});
		item.append(button);
		resumeList.append(item);
	}
};

const refreshResumes = async () => {
	renderResumes(await invoke<ResumeListItem[]>("list_resumes"));
};

const loadResume = async (id: string) => {
	const record = await invoke<ResumeRecord>("read_resume", { id });
	openResumeId = record.id;
	resumeDocument = record.document;
	showDocument(record.name);
};

const bytesToBase64 = (bytes: Uint8Array) => {
	let binary = "";
	const size = 0x8000;
	for (let index = 0; index < bytes.length; index += size) {
		binary += String.fromCharCode(...bytes.subarray(index, index + size));
	}
	return btoa(binary);
};

const exportResume = async () => {
	if (!status || !resumeDocument) return;
	status.textContent = "";
	const blob = await createResumePdfBlob({ data: resumeDocument });
	const pdfBase64 = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
	const path = await invoke<string>("save_resume_pdf", { pdfBase64 });
	status.textContent = `Exported ${path}`;
};

newResumeButton?.addEventListener("click", () => {
	const resume = blankResume();
	void invoke<ResumeListItem>("create_resume", { name: "Untitled resume", document: resume })
		.then(async (created) => {
			openResumeId = created.id;
			resumeDocument = resume;
			if (persist) persist.textContent = "";
			showDocument(created.name);
			await refreshResumes();
		})
		.catch(showError);
});

deleteResumeButton?.addEventListener("click", () => {
	if (!openResumeId) return;
	const id = openResumeId;
	void invoke("delete_resume", { id })
		.then(async () => {
			openResumeId = undefined;
			resumeDocument = undefined;
			editor?.setAttribute("hidden", "");
			await refreshResumes();
		})
		.catch(showError);
});

titleInput?.addEventListener("input", () => {
	if (!openResumeId || !titleInput) return;
	const id = openResumeId;
	const name = titleInput.value;
	void invoke("rename_resume", { id, name })
		.then(() => refreshResumes())
		.catch(showError);
});

nameInput?.addEventListener("input", () => {
	if (!resumeDocument || !nameInput) return;
	resumeDocument.basics.name = nameInput.value;
	saveDocument();
});

const isTemplate = (value: string): value is Template => templateSchema.options.some((template) => template === value);

templateSelect?.addEventListener("change", () => {
	if (!resumeDocument || !templateSelect || !isTemplate(templateSelect.value)) return;
	resumeDocument.metadata.template = templateSelect.value;
	saveDocument();
});

paperSelect?.addEventListener("change", () => {
	if (!resumeDocument || !paperSelect) return;
	const format = paperSelect.value;
	if (format !== "a4" && format !== "letter") return;
	resumeDocument.metadata.page.format = format;
	saveDocument();
});

summaryInput?.addEventListener("input", () => {
	if (!resumeDocument || !summaryInput) return;
	resumeDocument.summary.content = `<p>${escapeHtml(summaryInput.value)}</p>`;
	saveDocument();
});

skillInput?.addEventListener("input", () => {
	if (!resumeDocument || !skillInput) return;
	const name = skillInput.value;
	const current = resumeDocument.sections.skills.items[0];
	if (!name.trim()) {
		resumeDocument.sections.skills.items = [];
	} else if (current) {
		current.name = name;
	} else {
		resumeDocument.sections.skills.items = [skillNamed(name)];
	}
	saveDocument();
});

addItemButton?.addEventListener("click", () => {
	if (!resumeDocument) return;
	if (resumeDocument.sections.experience.items.length === 0) {
		resumeDocument.sections.experience.items.push(emptyExperience());
	}
	experienceItem?.removeAttribute("hidden");
	saveDocument();
});

companyInput?.addEventListener("input", () => {
	const item = resumeDocument?.sections.experience.items[0];
	if (!item || !companyInput) return;
	item.company = companyInput.value;
	saveDocument();
});

positionInput?.addEventListener("input", () => {
	const item = resumeDocument?.sections.experience.items[0];
	if (!item || !positionInput) return;
	item.position = positionInput.value;
	saveDocument();
});

exportButton?.addEventListener("click", () => {
	void exportResume().catch(showError);
});

if (templateSelect) {
	for (const template of templateSchema.options) {
		const option = document.createElement("option");
		option.value = template;
		option.textContent = template.charAt(0).toUpperCase() + template.slice(1);
		templateSelect.append(option);
	}
}

void refreshResumes().catch(showError);
