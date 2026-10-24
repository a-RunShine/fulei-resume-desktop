import { createFileRoute, redirect } from "@tanstack/react-router";
import { AuthLayout } from "@/features/auth/layout";
import { authSearchSchema } from "@/features/auth/redirect";
import { desktopEntryRedirect } from "@/libs/desktop-entry";
import { createNoindexFollowMeta } from "@/libs/seo";

export const Route = createFileRoute("/auth")({
	component: AuthLayout,
	validateSearch: authSearchSchema,
	beforeLoad: () => {
		const desktop = desktopEntryRedirect(globalThis);
		if (desktop) throw redirect(desktop);
	},
	head: () => ({
		meta: [createNoindexFollowMeta()],
	}),
});
