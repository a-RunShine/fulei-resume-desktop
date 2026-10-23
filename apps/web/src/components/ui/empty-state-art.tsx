import type { ReactElement } from "react";

export type EmptyStateArtVariant = "assistant" | "career" | "applications";

type EmptyStateArtProps = {
	variant: EmptyStateArtVariant;
	size?: number;
	className?: string;
};

const LINE = "var(--ink-2)";
const ACCENT = "var(--accent)";

const assistantArt = (
	<>
		<rect x="26" y="16" width="58" height="76" rx="10" stroke={LINE} strokeWidth="2.6" />
		<line x1="38" y1="34" x2="66" y2="34" stroke={LINE} strokeWidth="2.6" strokeLinecap="round" />
		<line x1="38" y1="46" x2="72" y2="46" stroke={LINE} strokeWidth="2.2" strokeLinecap="round" opacity=".45" />
		<line x1="38" y1="58" x2="60" y2="58" stroke={LINE} strokeWidth="2.2" strokeLinecap="round" opacity=".45" />
		<line x1="38" y1="70" x2="68" y2="70" stroke={LINE} strokeWidth="2.2" strokeLinecap="round" opacity=".45" />
		<rect x="58" y="62" width="44" height="13" rx="4" fill={ACCENT} opacity=".16" />
		<path d="M86 84 L95 75" stroke={ACCENT} strokeWidth="3.6" strokeLinecap="round" />
		<path d="M95 75 L101 69 L99 78 Z" fill={ACCENT} />
	</>
);

const careerArt = (
	<>
		<circle cx="44" cy="42" r="15" stroke={LINE} strokeWidth="2.6" />
		<path d="M22 88 C22 68 32 60 44 60 C56 60 66 68 66 88" stroke={LINE} strokeWidth="2.6" strokeLinecap="round" />
		<path
			d="M70 28 H100 A7 7 0 0 1 107 35 V60 A7 7 0 0 1 100 67 H87 L76 78 V67 H70 A7 7 0 0 1 63 60 V35 A7 7 0 0 1 70 28 Z"
			fill={ACCENT}
			opacity=".14"
			stroke={ACCENT}
			strokeWidth="2.4"
			strokeLinejoin="round"
		/>
		<circle cx="78" cy="47" r="2.6" fill={ACCENT} />
		<circle cx="87" cy="47" r="2.6" fill={ACCENT} />
		<circle cx="96" cy="47" r="2.6" fill={ACCENT} />
	</>
);

const applicationsArt = (
	<>
		<rect x="20" y="32" width="50" height="64" rx="9" fill={ACCENT} opacity=".12" stroke={LINE} strokeWidth="2.2" />
		<rect x="32" y="22" width="50" height="64" rx="9" fill="var(--surface)" stroke={LINE} strokeWidth="2.4" />
		<line x1="44" y1="40" x2="70" y2="40" stroke={LINE} strokeWidth="2.4" strokeLinecap="round" />
		<line x1="44" y1="52" x2="62" y2="52" stroke={LINE} strokeWidth="2" strokeLinecap="round" opacity=".45" />
		<circle cx="86" cy="82" r="17" fill={ACCENT} />
		<path
			d="M79 82 L84 87 L94 77"
			stroke="var(--surface)"
			strokeWidth="3"
			strokeLinecap="round"
			strokeLinejoin="round"
		/>
	</>
);

const artByVariant = {
	assistant: assistantArt,
	career: careerArt,
	applications: applicationsArt,
} satisfies Record<EmptyStateArtVariant, ReactElement>;

const defaultSize = { assistant: 120, career: 120, applications: 96 };

export function EmptyStateArt({ variant, size, className }: EmptyStateArtProps) {
	return (
		<svg
			width={size ?? defaultSize[variant]}
			height={size ?? defaultSize[variant]}
			viewBox="0 0 120 120"
			fill="none"
			aria-hidden="true"
			className={className}
		>
			{artByVariant[variant]}
		</svg>
	);
}
