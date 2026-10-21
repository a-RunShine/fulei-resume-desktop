const packageNameOf = (id: string) => {
	const normalized = id.replaceAll("\\", "/");
	const [first, second] = normalized.split("/");
	if (normalized.startsWith("@") && first && second) return `${first}/${second}`;
	return first ?? normalized;
};

export function desktopServerDependencyStaysExternal(id: string): boolean {
	const normalized = id.replaceAll("\\", "/");
	if (
		normalized.startsWith("@reactive-resume/") ||
		normalized.includes("/@reactive-resume/") ||
		normalized.startsWith(".") ||
		normalized.startsWith("/") ||
		normalized.startsWith("#") ||
		normalized.startsWith("@/") ||
		normalized.startsWith("\0")
	) {
		return false;
	}
	if (normalized.endsWith(".wasm") || normalized.endsWith(".node")) return true;
	const name = packageNameOf(normalized);
	return (
		name === "@electric-sql/pglite" ||
		name === "sharp" ||
		name === "css-tree" ||
		name === "mdn-data" ||
		name.startsWith("@img/")
	);
}

export function desktopServerShouldBundleDependency(id: string): boolean {
	const normalized = id.replaceAll("\\", "/");
	if (normalized.startsWith("node:")) return false;
	return !desktopServerDependencyStaysExternal(id);
}
