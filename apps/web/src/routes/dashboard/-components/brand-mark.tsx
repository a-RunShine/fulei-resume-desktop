import { BrandIcon } from "@reactive-resume/ui/components/brand-icon";
import { cn } from "@reactive-resume/utils/style";

export const BRAND_NAME = "Fulei Resume";

type BrandMarkProps = {
	showName?: boolean;
	className?: string;
};

export function BrandMark({ showName = true, className }: BrandMarkProps) {
	return (
		<div className={cn("flex h-9 items-center gap-2.5 px-1.5", className)}>
			<BrandIcon variant="icon" alt="" className="size-6 shrink-0" />
			{showName && <span className="text-sm font-semibold">{BRAND_NAME}</span>}
		</div>
	);
}
