import { contrastRatio, relativeLuminance } from "./create-ramp.js";

interface Oklch {
	L: number;
	C: number;
	H: number;
}

/** sRGB to OKLCH; neutral colors have no meaningful hue. */
export function hexToOklch(hex: string): Oklch {
	const [r = 0, g = 0, b = 0] = [1, 3, 5].map((index) => {
		const value = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
		return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	});
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
	const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
	const b2 = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
	const C = Math.hypot(a, b2);
	return {
		L: Math.max(0, Math.min(1, L)),
		C: C < 1e-6 ? 0 : C,
		H: C < 1e-6 ? 0 : ((Math.atan2(b2, a) * 180) / Math.PI + 360) % 360,
	};
}

function toHex({ L, C, H }: Oklch): string | undefined {
	const a = C * Math.cos((H * Math.PI) / 180);
	const b = C * Math.sin((H * Math.PI) / 180);
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
	const linear = [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	];
	if (!linear.every((value) => value >= -1e-7 && value <= 1 + 1e-7)) return undefined;
	return `#${linear
		.map((value) => {
			const gamma = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
			return Math.round(Math.max(0, Math.min(1, gamma)) * 255)
				.toString(16)
				.padStart(2, "0");
		})
		.join("")}`;
}

/** Same search as the approved demo: change lightness first, then reduce chroma only if necessary. */
export function adaptTextColor(text: string, background: string, minimumContrast = 4): string {
	const base = hexToOklch(text);
	const bg = relativeLuminance(background);
	const passes = (hex: string) => contrastRatio(relativeLuminance(hex), bg) >= minimumContrast;
	if (passes(text)) return text.toLowerCase();
	for (let step = 0; step <= 40; step++) {
		const C = base.C * (1 - step / 40);
		let best: { hex: string; distance: number } | undefined;
		for (let index = 0; index <= 400; index++) {
			const L = index / 400;
			const distance = Math.abs(L - base.L);
			if (best && distance >= best.distance) continue;
			const hex = toHex({ L, C, H: base.H });
			if (hex && passes(hex)) best = { hex, distance };
		}
		if (best) return best.hex;
	}
	return contrastRatio(0, bg) >= contrastRatio(1, bg) ? "#000000" : "#ffffff";
}
