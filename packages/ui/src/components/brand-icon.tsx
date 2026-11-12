import { APP_PRODUCT_NAME } from "@reactive-resume/utils/product";
import { cn } from "@reactive-resume/utils/style";

type Props = React.ComponentProps<"img"> & {
	variant?: "logo" | "icon";
};

export function BrandIcon({ variant = "logo", className, ...props }: Props) {
	return (
		<>
			<img
				src={`/${variant}/dark.svg`}
				alt={APP_PRODUCT_NAME}
				className={cn("hidden size-12 object-contain dark:block", className)}
				{...props}
			/>
			<img
				src={`/${variant}/light.svg`}
				alt={APP_PRODUCT_NAME}
				className={cn("block size-12 object-contain dark:hidden", className)}
				{...props}
			/>
		</>
	);
}
