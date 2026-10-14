import type {
	EducationItem,
	ExperienceItem,
	ProfileItem,
	ResumeData,
	SkillItem,
} from "@reactive-resume/schema/resume/data";
import type { Template } from "@reactive-resume/schema/templates";
import type { PDFDocumentLoadingTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import { invoke } from "@tauri-apps/api/core";
import { AnnotationMode, getDocument, GlobalWorkerOptions, TextLayer } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createResumePdfBlob } from "@reactive-resume/pdf/browser";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { templateSchema } from "@reactive-resume/schema/templates";

GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();

const status = document.querySelector<HTMLElement>("#status");
const persist = document.querySelector<HTMLElement>("#persist");
const resumeList = document.querySelector<HTMLUListElement>("#resumes");
const newResumeButton = document.querySelector<HTMLButtonElement>("#new-resume");
const editor = document.querySelector<HTMLElement>("#editor");
const titleInput = document.querySelector<HTMLInputElement>("#title");
const deleteResumeButton = document.querySelector<HTMLButtonElement>("#delete-resume");
const nameInput = document.querySelector<HTMLInputElement>("#basics-name");
const pictureUrlInput = document.querySelector<HTMLInputElement>("#picture-url");
const pictureVisibleInput = document.querySelector<HTMLInputElement>("#picture-visible");
const summaryInput = document.querySelector<HTMLTextAreaElement>("#summary");
const addItemButton = document.querySelector<HTMLButtonElement>("#add-item");
const removeItemButton = document.querySelector<HTMLButtonElement>("#remove-item");
const addProfileButton = document.querySelector<HTMLButtonElement>("#add-profile");
const profileItem = document.querySelector<HTMLElement>("#profile-item");
const networkInput = document.querySelector<HTMLInputElement>("#network");
const addEducationButton = document.querySelector<HTMLButtonElement>("#add-education");
const educationItem = document.querySelector<HTMLElement>("#education-item");
const schoolInput = document.querySelector<HTMLInputElement>("#school");
const templateSelect = document.querySelector<HTMLSelectElement>("#template");
const paperSelect = document.querySelector<HTMLSelectElement>("#paper");
const experienceItem = document.querySelector<HTMLElement>("#experience-item");
const skillInput = document.querySelector<HTMLInputElement>("#skill");
const companyInput = document.querySelector<HTMLInputElement>("#company");
const positionInput = document.querySelector<HTMLInputElement>("#position");
const exportButton = document.querySelector<HTMLButtonElement>("#export-pdf");
const resumePage = document.querySelector<HTMLElement>("#resume-page");
const resumeSheet = document.querySelector<HTMLElement>("#resume-sheet");
const resumeCanvas = document.querySelector<HTMLCanvasElement>("#resume-canvas");
const resumeText = document.querySelector<HTMLDivElement>("#resume-text");
const providerForm = document.querySelector<HTMLFormElement>("#provider");
const providerStatus = document.querySelector<HTMLElement>("#provider-status");
const reply = document.querySelector<HTMLElement>("#reply");
const askButton = document.querySelector<HTMLButtonElement>("#ask");
const sections = document.querySelector<HTMLElement>("#sections");

const railSections = ["picture", "basics", "summary", "profiles", "experience", "education"] as const;

const showSection = (name: (typeof railSections)[number]) => {
	for (const section of railSections) {
		const region = document.querySelector(`#section-${section}`);
		const button = sections?.querySelector<HTMLButtonElement>(`[data-section="${section}"]`);
		if (section === name) {
			region?.removeAttribute("hidden");
			button?.setAttribute("aria-pressed", "true");
		} else {
			region?.setAttribute("hidden", "");
			button?.setAttribute("aria-pressed", "false");
		}
	}
};

const isRailSection = (name: string | undefined): name is (typeof railSections)[number] =>
	railSections.some((section) => section === name);

sections?.addEventListener("click", (event) => {
	const target = event.target;
	const button = target instanceof HTMLElement ? target.closest("button") : null;
	const name = button instanceof HTMLButtonElement ? button.dataset.section : undefined;
	if (isRailSection(name)) showSection(name);
});

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

const messageFrom = (error: unknown) => (error instanceof Error ? error.message : String(error));

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

const emptyProfile = (): ProfileItem => ({
	id: crypto.randomUUID(),
	hidden: false,
	icon: "",
	iconColor: "",
	network: "",
	username: "",
	website: { url: "", label: "", inlineLink: false },
});

const emptyEducation = (): EducationItem => ({
	id: crypto.randomUUID(),
	hidden: false,
	school: "",
	degree: "",
	area: "",
	grade: "",
	location: "",
	period: "",
	website: { url: "", label: "", inlineLink: false },
	description: "",
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

const previewScale = 0.55;
let previewGeneration = 0;
let previewTimer = 0;
let previewTask: PDFDocumentLoadingTask | undefined;
let previewLayer: TextLayer | undefined;
let pdfQueue: Promise<void> = Promise.resolve();

const renderResumePdf = (data: ResumeData) => {
	const snapshot = structuredClone(data);
	const run = pdfQueue.then(() => createResumePdfBlob({ data: snapshot }));
	pdfQueue = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
};

const cancelPreviewLayer = () => {
	previewLayer?.cancel();
	previewLayer = undefined;
};

const paintPreview = async (data: ResumeData, generation: number) => {
	if (!resumePage || !resumeSheet || !resumeCanvas || !resumeText) return;
	const blob = await renderResumePdf(data);
	if (generation !== previewGeneration) return;
	const task = getDocument({ data: new Uint8Array(await blob.arrayBuffer()), verbosity: 0 });
	previewTask = task;
	try {
		const pdf = await task.promise;
		if (generation !== previewGeneration) return;
		const pdfPage = await pdf.getPage(1);
		const viewport = pdfPage.getViewport({ scale: previewScale });
		resumeSheet.style.width = `${viewport.width}px`;
		resumeSheet.style.height = `${viewport.height}px`;
		resumeCanvas.width = Math.ceil(viewport.width);
		resumeCanvas.height = Math.ceil(viewport.height);
		await pdfPage.render({ canvas: resumeCanvas, viewport, annotationMode: AnnotationMode.DISABLE }).promise;
		if (generation !== previewGeneration) return;
		resumePage.removeAttribute("hidden");
		const textContent = await pdfPage.getTextContent();
		if (generation !== previewGeneration) return;
		cancelPreviewLayer();
		resumeText.replaceChildren();
		const layer = new TextLayer({ textContentSource: textContent, container: resumeText, viewport });
		previewLayer = layer;
		await layer.render();
	} finally {
		if (previewTask === task) previewTask = undefined;
		await task.destroy().catch(() => undefined);
	}
};

const schedulePreview = () => {
	if (!resumeDocument) return;
	cancelPreviewLayer();
	const generation = ++previewGeneration;
	const snapshot = structuredClone(resumeDocument);
	window.clearTimeout(previewTimer);
	previewTimer = window.setTimeout(() => {
		void paintPreview(snapshot, generation).catch((error: unknown) => {
			if (generation !== previewGeneration) return;
			console.error(error instanceof Error ? error.message : String(error));
		});
	}, 200);
};

const hidePage = () => {
	previewGeneration += 1;
	window.clearTimeout(previewTimer);
	cancelPreviewLayer();
	const task = previewTask;
	previewTask = undefined;
	if (task) void task.destroy().catch(() => undefined);
	resumeText?.replaceChildren();
	resumePage?.setAttribute("hidden", "");
};

const showDocument = (title: string) => {
	if (!resumeDocument) return;
	if (titleInput) titleInput.value = title;
	if (nameInput) nameInput.value = resumeDocument.basics.name;
	if (pictureUrlInput) pictureUrlInput.value = resumeDocument.picture.url;
	if (pictureVisibleInput) pictureVisibleInput.checked = !resumeDocument.picture.hidden;
	if (summaryInput) summaryInput.value = summaryText(resumeDocument.summary.content);
	if (templateSelect) templateSelect.value = resumeDocument.metadata.template;
	if (paperSelect) {
		paperSelect.value = resumeDocument.metadata.page.format === "letter" ? "letter" : "a4";
	}
	if (skillInput) skillInput.value = resumeDocument.sections.skills.items[0]?.name ?? "";
	const profile = resumeDocument.sections.profiles.items[0];
	if (profile) {
		profileItem?.removeAttribute("hidden");
		if (networkInput) networkInput.value = profile.network;
	} else {
		profileItem?.setAttribute("hidden", "");
		if (networkInput) networkInput.value = "";
	}
	const education = resumeDocument.sections.education.items[0];
	if (education) {
		educationItem?.removeAttribute("hidden");
		if (schoolInput) schoolInput.value = education.school;
	} else {
		educationItem?.setAttribute("hidden", "");
		if (schoolInput) schoolInput.value = "";
	}
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
	resumePage?.setAttribute("hidden", "");
	schedulePreview();
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
	schedulePreview();
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
	const blob = await renderResumePdf(resumeDocument);
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
			hidePage();
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

const applyPicture = () => {
	if (!resumeDocument || !pictureUrlInput || !pictureVisibleInput) return;
	resumeDocument.picture.url = pictureUrlInput.value;
	resumeDocument.picture.hidden = !pictureVisibleInput.checked;
	saveDocument();
};

pictureUrlInput?.addEventListener("input", applyPicture);
pictureVisibleInput?.addEventListener("change", applyPicture);

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

addProfileButton?.addEventListener("click", () => {
	if (!resumeDocument) return;
	if (resumeDocument.sections.profiles.items.length === 0) {
		resumeDocument.sections.profiles.items.push(emptyProfile());
	}
	profileItem?.removeAttribute("hidden");
	saveDocument();
});

networkInput?.addEventListener("input", () => {
	const item = resumeDocument?.sections.profiles.items[0];
	if (!item || !networkInput) return;
	item.network = networkInput.value;
	saveDocument();
});

addEducationButton?.addEventListener("click", () => {
	if (!resumeDocument) return;
	if (resumeDocument.sections.education.items.length === 0) {
		resumeDocument.sections.education.items.push(emptyEducation());
	}
	educationItem?.removeAttribute("hidden");
	saveDocument();
});

schoolInput?.addEventListener("input", () => {
	const item = resumeDocument?.sections.education.items[0];
	if (!item || !schoolInput) return;
	item.school = schoolInput.value;
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

removeItemButton?.addEventListener("click", () => {
	if (!resumeDocument) return;
	resumeDocument.sections.experience.items.shift();
	const item = resumeDocument.sections.experience.items[0];
	if (item) {
		if (companyInput) companyInput.value = item.company;
		if (positionInput) positionInput.value = item.position;
	} else {
		experienceItem?.setAttribute("hidden", "");
		if (companyInput) companyInput.value = "";
		if (positionInput) positionInput.value = "";
	}
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
	void invoke<string>("ask_assistant", { resume: JSON.stringify(resumeDocument ?? blankResume()) })
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
