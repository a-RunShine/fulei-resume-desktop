import type { ExperienceItem, ResumeData, SkillItem } from "@reactive-resume/schema/resume/data";
import type { Template } from "@reactive-resume/schema/templates";
import type { PDFDocumentLoadingTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import { invoke } from "@tauri-apps/api/core";
import { AnnotationMode, getDocument, GlobalWorkerOptions, TextLayer } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createResumePdfBlob } from "@reactive-resume/pdf/browser";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { templateLayouts, templateSchema } from "@reactive-resume/schema/templates";

GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();

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
const singleColumnFilter = document.querySelector<HTMLInputElement>("#filter-single");
const atsFilter = document.querySelector<HTMLInputElement>("#filter-ats");
const paperSelect = document.querySelector<HTMLSelectElement>("#paper");
const experienceItem = document.querySelector<HTMLElement>("#experience-item");
const skillInput = document.querySelector<HTMLInputElement>("#skill");
const companyInput = document.querySelector<HTMLInputElement>("#company");
const positionInput = document.querySelector<HTMLInputElement>("#position");
const exportButton = document.querySelector<HTMLButtonElement>("#export-pdf");
const resumePage = document.querySelector<HTMLElement>("#resume-page");
const templateCurrent = document.querySelector<HTMLElement>("#template-current");
const templateThumb = document.querySelector<HTMLImageElement>("#template-thumb");
const layoutPages = document.querySelector<HTMLElement>("#layout-pages");
const resumeSheet = document.querySelector<HTMLElement>("#resume-sheet");
const resumeCanvas = document.querySelector<HTMLCanvasElement>("#resume-canvas");
const resumeText = document.querySelector<HTMLDivElement>("#resume-text");
const previousPageButton = document.querySelector<HTMLButtonElement>("#previous-page");
const nextPageButton = document.querySelector<HTMLButtonElement>("#next-page");
const pageStatus = document.querySelector<HTMLElement>("#page-status");
const addPageButton = document.querySelector<HTMLButtonElement>("#add-page");
const sidebarWidthInput = document.querySelector<HTMLInputElement>("#sidebar-width");
const providerForm = document.querySelector<HTMLFormElement>("#provider");
const providerStatus = document.querySelector<HTMLElement>("#provider-status");
const reply = document.querySelector<HTMLElement>("#reply");
const askButton = document.querySelector<HTMLButtonElement>("#ask");

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
let previewBytes: Uint8Array | undefined;
let previewPageCount = 0;
let previewPageIndex = 0;
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

const updatePageControls = () => {
	if (previousPageButton) previousPageButton.disabled = previewPageIndex <= 0;
	if (nextPageButton) nextPageButton.disabled = previewPageIndex >= previewPageCount - 1;
	if (pageStatus) {
		pageStatus.textContent = previewPageCount === 0 ? "" : `${previewPageIndex + 1} of ${previewPageCount}`;
	}
};

const paintStoredPage = async (bytes: Uint8Array, pageIndex: number, generation: number) => {
	if (!resumePage || !resumeSheet || !resumeCanvas || !resumeText) return;
	const task = getDocument({ data: bytes.slice(), verbosity: 0 });
	previewTask = task;
	try {
		const pdf = await task.promise;
		if (generation !== previewGeneration) return;
		previewPageCount = pdf.numPages;
		const safeIndex = Math.min(Math.max(pageIndex, 0), Math.max(pdf.numPages - 1, 0));
		previewPageIndex = safeIndex;
		updatePageControls();
		const pdfPage = await pdf.getPage(safeIndex + 1);
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

const paintPreview = async (data: ResumeData, generation: number) => {
	const blob = await renderResumePdf(data);
	if (generation !== previewGeneration) return;
	const bytes = new Uint8Array(await blob.arrayBuffer());
	previewBytes = bytes;
	await paintStoredPage(bytes, previewPageIndex, generation);
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
			const message = error instanceof Error ? error.message : String(error);
			if (pageStatus) pageStatus.textContent = message;
			console.error(message);
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
	previewBytes = undefined;
	previewPageCount = 0;
	previewPageIndex = 0;
	updatePageControls();
};

const showDocument = (title: string) => {
	if (!resumeDocument) return;
	previewPageIndex = 0;
	if (titleInput) titleInput.value = title;
	if (nameInput) nameInput.value = resumeDocument.basics.name;
	if (summaryInput) summaryInput.value = summaryText(resumeDocument.summary.content);
	renderTemplateOptions();
	showTemplate(resumeDocument.metadata.template);
	if (sidebarWidthInput) sidebarWidthInput.value = String(resumeDocument.metadata.layout.sidebarWidth);
	renderLayout();
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

const isTemplate = (value: string): value is Template => templateSchema.options.some((template) => template === value);

const templateName = (template: Template) => template.charAt(0).toUpperCase() + template.slice(1);

const templateThumbnail = (template: Template) => {
	const bars =
		templateLayouts[template].columns === 1
			? `<rect x="8" y="8" width="56" height="80" fill="#e8e4dc"/>`
			: `<rect x="8" y="8" width="22" height="80" fill="#d9d3c7"/><rect x="34" y="8" width="30" height="80" fill="#efeae2"/>`;
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="96" viewBox="0 0 72 96"><rect width="72" height="96" fill="#ffffff"/>${bars}</svg>`;
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};

const showTemplate = (template: Template) => {
	const name = templateName(template);
	if (templateCurrent) templateCurrent.textContent = name;
	if (templateThumb) {
		templateThumb.alt = name;
		templateThumb.src = templateThumbnail(template);
	}
};

const templateVisible = (template: Template) => {
	const layout = templateLayouts[template];
	if (singleColumnFilter?.checked && layout.columns !== 1) return false;
	if (atsFilter?.checked && !layout.atsSafe) return false;
	return true;
};

const sectionLabels: Record<string, string> = {
	profiles: "Profiles",
	summary: "Summary",
	education: "Education",
	experience: "Experience",
	projects: "Projects",
	volunteer: "Volunteer",
	references: "References",
	skills: "Skills",
	certifications: "Certifications",
	awards: "Awards",
	languages: "Languages",
	interests: "Interests",
	publications: "Publications",
};

const sectionLabel = (id: string) => sectionLabels[id] ?? id;

const moveLabel = (id: string) => {
	if (id === "summary") return "overview";
	if (id === "skills") return "abilities";
	return sectionLabel(id);
};

type LayoutColumn = "main" | "sidebar";

const moveSection = (pageIndex: number, column: LayoutColumn, sectionId: string, direction: -1 | 1) => {
	const layoutPage = resumeDocument?.metadata.layout.pages[pageIndex];
	if (!layoutPage) return;
	const items = layoutPage[column];
	const index = items.indexOf(sectionId);
	const neighbor = items[index + direction];
	if (index < 0 || neighbor === undefined) return;
	items[index] = neighbor;
	items[index + direction] = sectionId;
	saveDocument();
	renderLayout();
};

const moveSectionToPage = (fromPage: number, column: LayoutColumn, sectionId: string, toPage: number) => {
	const pages = resumeDocument?.metadata.layout.pages;
	const from = pages?.[fromPage]?.[column];
	const target = pages?.[toPage];
	if (!from || !target) return;
	const index = from.indexOf(sectionId);
	if (index < 0) return;
	from.splice(index, 1);
	target.main.push(sectionId);
	saveDocument();
	renderLayout();
};

const renderLayout = () => {
	const current = resumeDocument;
	if (!layoutPages || !current) return;
	layoutPages.replaceChildren();
	current.metadata.layout.pages.forEach((layoutPage, pageIndex) => {
		const group = document.createElement("div");
		const heading = document.createElement("h3");
		heading.textContent = `Page ${pageIndex + 1}`;
		group.append(heading);
		for (const column of ["main", "sidebar"] as const) {
			const list = document.createElement("ol");
			list.setAttribute("aria-label", column === "main" ? "Main" : "Sidebar");
			for (const sectionId of layoutPage[column]) {
				const item = document.createElement("li");
				const label = sectionLabel(sectionId);
				item.append(label);
				const up = document.createElement("button");
				up.type = "button";
				up.textContent = "Up";
				up.setAttribute("aria-label", `Raise ${moveLabel(sectionId)}`);
				up.addEventListener("click", () => {
					moveSection(pageIndex, column, sectionId, -1);
				});
				const down = document.createElement("button");
				down.type = "button";
				down.textContent = "Down";
				down.setAttribute("aria-label", `Lower ${moveLabel(sectionId)}`);
				down.addEventListener("click", () => {
					moveSection(pageIndex, column, sectionId, 1);
				});
				item.append(up, down);
				if (current.metadata.layout.pages[pageIndex + 1]) {
					const onward = document.createElement("button");
					onward.type = "button";
					onward.textContent = "Onward";
					onward.setAttribute("aria-label", `Onward ${moveLabel(sectionId)}`);
					onward.addEventListener("click", () => {
						moveSectionToPage(pageIndex, column, sectionId, pageIndex + 1);
					});
					item.append(onward);
				}
				list.append(item);
			}
			group.append(list);
		}
		layoutPages.append(group);
	});
};

const renderTemplateOptions = () => {
	if (!templateSelect) return;
	const current = resumeDocument?.metadata.template;
	const selected = current ?? (isTemplate(templateSelect.value) ? templateSelect.value : "onyx");
	templateSelect.replaceChildren();
	for (const template of templateSchema.options) {
		if (!templateVisible(template) && template !== selected) continue;
		const option = document.createElement("option");
		option.value = template;
		option.textContent = templateName(template);
		templateSelect.append(option);
	}
	templateSelect.value = selected;
};

const addLayoutPage = () => {
	if (!resumeDocument) return;
	resumeDocument.metadata.layout.pages.push({ fullWidth: false, main: [], sidebar: [] });
	saveDocument();
	renderLayout();
};

const showPreviewPage = (pageIndex: number) => {
	if (!previewBytes) return;
	const generation = previewGeneration;
	void paintStoredPage(previewBytes, pageIndex, generation).catch((error: unknown) => {
		if (generation !== previewGeneration) return;
		console.error(error instanceof Error ? error.message : String(error));
	});
};

templateSelect?.addEventListener("change", () => {
	if (!resumeDocument || !templateSelect || !isTemplate(templateSelect.value)) return;
	resumeDocument.metadata.template = templateSelect.value;
	showTemplate(templateSelect.value);
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

addPageButton?.addEventListener("click", addLayoutPage);
sidebarWidthInput?.addEventListener("input", () => {
	if (!resumeDocument || !sidebarWidthInput) return;
	const width = Number(sidebarWidthInput.value);
	if (!Number.isFinite(width)) return;
	resumeDocument.metadata.layout.sidebarWidth = width;
	saveDocument();
});
previousPageButton?.addEventListener("click", () => {
	showPreviewPage(previewPageIndex - 1);
});
nextPageButton?.addEventListener("click", () => {
	showPreviewPage(previewPageIndex + 1);
});
updatePageControls();

renderTemplateOptions();
singleColumnFilter?.addEventListener("change", renderTemplateOptions);
atsFilter?.addEventListener("change", renderTemplateOptions);

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
