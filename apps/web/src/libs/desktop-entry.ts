import { detectionRuntime } from "./desktop-runtime";

const DESKTOP_ENTRY = "/desktop/enter";

export const desktopEntryRedirect = (scope: unknown) => {
	if (detectionRuntime(scope) !== "desktop") return;
	return { href: DESKTOP_ENTRY, reloadDocument: true, replace: true } as const;
};
