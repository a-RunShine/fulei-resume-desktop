import { sampleResumeData } from "@reactive-resume/schema/resume/sample";
import { createResumePdfBlob } from "../src/browser";

type PocResult = { state: "ok"; size: number; base64: string } | { state: "error"; message: string };

const report = (result: PocResult) => {
	(window as unknown as { __poc: PocResult }).__poc = result;
};

const chinese = new URLSearchParams(window.location.search).get("zh") === "1";
const withChineseText = (data: typeof sampleResumeData) => {
	if (!chinese) return data;
	const copy = structuredClone(data);
	copy.basics.name = "张三";
	copy.summary.content = "<p>我是一名前端工程师，熟悉 React 与 TypeScript，擅长简历与排版相关的工程实现。</p>";
	return copy;
};

const run = async () => {
	try {
		const blob = await createResumePdfBlob({ data: withChineseText(sampleResumeData) });
		const bytes = new Uint8Array(await blob.arrayBuffer());
		let binary = "";
		for (const byte of bytes) binary += String.fromCharCode(byte);
		report({ state: "ok", size: bytes.length, base64: btoa(binary) });
	} catch (error) {
		report({ state: "error", message: error instanceof Error ? error.message : String(error) });
	}
};

void run();
