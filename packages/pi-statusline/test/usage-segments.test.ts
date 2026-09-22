import assert from "node:assert/strict";
import type { ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { renderPowerlineStatusline } from "../src/powerline.js";
import { type RuntimeState, renderStatusline } from "../src/render.js";
import { createDefaultConfig, normalizeStatuslineConfig } from "../src/settings.js";
import { PALETTE_PRESET_NAMES, type RenderSegment } from "../src/types.js";
import { CAROUSEL_PERIOD_MS } from "../src/usage-windows.js";

const ESCAPE = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESCAPE}\\[[0-9;]*m`, "gu");
const FIVE_HOURS = 300;
const SEVEN_DAYS = 7 * 24 * 60;

const TRANSITION = "\ue0b4";

function plain(value: string): string {
	return value.replace(ANSI_PATTERN, "").replaceAll(TRANSITION, "");
}

function transitions(value: string): number {
	return value.split(TRANSITION).length - 1;
}

function colorsOf(rendered: string, text: string): { fg?: string; bg?: string } {
	const match = new RegExp(`${ESCAPE}\\[([0-9;]*)m[^${ESCAPE}]*${text}`, "u").exec(rendered);
	const codes = match?.[1] ?? "";
	const fg = /38;2;(\d+;\d+;\d+)/u.exec(codes)?.[1];
	const bg = /48;2;(\d+;\d+;\d+)/u.exec(codes)?.[1];
	return codes.startsWith("7;") ? { fg: bg, bg: fg } : { fg, bg };
}

const footerData: ReadonlyFooterDataProvider = {
	getGitBranch: () => null,
	getExtensionStatuses: () => new Map(),
	onBranchChange: () => () => undefined,
	getAvailableProviderCount: () => 1,
};

function runtimeWith(usage: RuntimeState["usage"], dollars = 0): RuntimeState {
	return {
		turnCount: 0,
		activeTools: new Map(),
		isStreaming: false,
		thinkingLevel: "off",
		duplicateExtensions: [],
		extensionStatusIconAliases: new Map(),
		usage,
		dailySpent: { day: 0, providerId: "openai-codex", dollars },
	};
}

afterEach(() => {
	vi.useRealTimers();
});

test("subscription windows render their countdown, then their value, in the configured order", () => {
	const now = 1_760_000_000_000;
	const frameStart = Math.floor(now / CAROUSEL_PERIOD_MS) * CAROUSEL_PERIOD_MS;
	vi.useFakeTimers({ now: frameStart });
	const config = createDefaultConfig();
	config.segments = ["five_hour", "weekly"];
	const context = createMockContext({ model: { id: "gpt-5.6-sol", provider: "openai-codex" } });
	const runtime = runtimeWith({
		providerId: "openai-codex",
		fiveHour: {
			bucketId: "codex:primary",
			usedPercent: 12.4,
			windowMinutes: FIVE_HOURS,
			resetsAt: frameStart / 1000 + 285 * 60,
			spent: 80,
			windowDollars: 647,
		},
		weekly: {
			bucketId: "codex:secondary",
			usedPercent: 8,
			windowMinutes: SEVEN_DAYS,
			resetsAt: frameStart / 1000 + 7_185 * 60,
			spent: 0,
		},
	});
	const render = () =>
		plain(renderStatusline(300, context.ctx, footerData, {} as Theme, config, runtime));

	const first = render();
	vi.setSystemTime(frameStart + CAROUSEL_PERIOD_MS);
	const second = render();
	const readings = [first, second].map((line) => line.replace(/\s+/gu, " ").trim());
	assert.ok(readings.includes("░▒▓ ◒ 12% (4h 45m) ◑ 8% (4d 23h)"), readings.join(" | "));
	assert.ok(readings.includes("░▒▓ ◒ 12% ($647) ◑ 8% (4d 23h)"), readings.join(" | "));
});

test("a window the provider did not report leaves its segment out", () => {
	const config = createDefaultConfig();
	config.segments = ["five_hour", "weekly", "cost"];
	const context = createMockContext({ model: { id: "gpt-5.6-sol", provider: "openai-codex" } });
	const weeklyOnly = runtimeWith({
		providerId: "openai-codex",
		weekly: {
			bucketId: "codex:primary",
			usedPercent: 6,
			windowMinutes: SEVEN_DAYS,
			resetsAt: Date.now() / 1000 + 60,
			spent: 0,
		},
	});
	weeklyOnly.dailyBudgetPercent = 0;
	assert.match(
		plain(renderStatusline(300, context.ctx, footerData, {} as Theme, config, weeklyOnly)),
		/^░▒▓ ◑ 6% \(\d+m\) ☉ \$0\.00 \(0%\)$/u,
	);
	assert.equal(
		plain(
			renderStatusline(300, context.ctx, footerData, {} as Theme, config, runtimeWith(undefined)),
		),
		"░▒▓ ☉ $0.00",
	);
});

test("every palette inverts the position's colors and leaves neighbours unchanged", () => {
	for (const palettePreset of PALETTE_PRESET_NAMES) {
		const config = normalizeStatuslineConfig({
			palettePreset,
			palette: [
				{ fg: "#090c0c", bg: "#ffcf70" },
				{ fg: "#f0f0f0", bg: "#493447" },
			],
		}).config;
		const items: RenderSegment[] = Array.from({ length: 12 }, (_, index) => ({
			name: "context",
			text: `item${index}!`,
			color: "accent",
		}));
		const normal = renderPowerlineStatusline(500, items, config);
		for (let index = 0; index < items.length; index++) {
			const alerting = items.map((item, position) => ({ ...item, alert: position === index }));
			const rendered = renderPowerlineStatusline(500, alerting, config);
			for (const [position, item] of items.entries()) {
				const colors = colorsOf(normal, item.text);
				assert.deepEqual(
					colorsOf(rendered, item.text),
					position === index ? { fg: colors.bg, bg: colors.fg } : colors,
					`${palettePreset} position ${position}, alert ${index}`,
				);
			}
			assert.equal(plain(rendered), plain(normal));
		}
	}
});

test("subscription alerts invert field colors in every palette without changing neighbours", () => {
	for (const palettePreset of PALETTE_PRESET_NAMES) {
		const config = normalizeStatuslineConfig({ palettePreset }).config;
		for (const name of ["five_hour", "weekly"] as const) {
			const items: RenderSegment[] = Array.from({ length: 12 }, (_, index) => ({
				name,
				text: `item${index}!`,
				color: "accent",
			}));
			const normal = renderPowerlineStatusline(500, items, config);
			for (let index = 0; index < items.length; index++) {
				const rendered = renderPowerlineStatusline(
					500,
					items.map((item, position) => ({ ...item, alert: position === index })),
					config,
				);
				for (const [position, item] of items.entries()) {
					const colors = colorsOf(normal, item.text);
					assert.deepEqual(
						colorsOf(rendered, item.text),
						position === index ? { fg: colors.bg, bg: colors.fg } : colors,
						`${palettePreset} ${name} position ${position}, alert ${index}`,
					);
				}
				assert.equal(plain(rendered), plain(normal));
			}
		}
	}
});

test("inverted blocks use their displayed backgrounds for rounded separators", () => {
	const config = normalizeStatuslineConfig({
		palettePreset: "custom",
		palette: [
			{ fg: "#090c0c", bg: "#ffcf70" },
			{ fg: "#f0f0f0", bg: "#493447" },
		],
	}).config;
	const items: RenderSegment[] = [
		{ name: "context", text: "context", color: "accent", alert: true },
		{ name: "weekly", text: "weekly", color: "accent", alert: true },
	];
	const rendered = renderPowerlineStatusline(300, items, config);
	assert.ok(rendered.includes(`${ESCAPE}[38;2;9;12;12;48;2;240;240;240m${TRANSITION}`));
	assert.ok(rendered.endsWith(`${ESCAPE}[38;2;240;240;240m${TRANSITION}${ESCAPE}[0m`));
	const indexed = renderPowerlineStatusline(300, items, config, false);
	assert.ok(indexed.includes(`${ESCAPE}[7;38;5;`));
	assert.equal(plain(indexed), plain(rendered));
});

test("an uncolored custom palette inverts terminal defaults", () => {
	const config = normalizeStatuslineConfig({ palettePreset: "custom", palette: [] }).config;
	const rendered = renderPowerlineStatusline(
		300,
		[{ name: "context", text: "context", color: "accent", alert: true }],
		config,
	);
	assert.ok(rendered.includes(`${ESCAPE}[7m context${ESCAPE}[0m`));
});

test("an alerting segment breaks out of a shared block", () => {
	const config = createDefaultConfig();
	config.palettePreset = "custom";
	config.palette = Array.from({ length: 2 }, () => ({ fg: "#090c0c", bg: "#a3aed2" }));
	const item = (name: RenderSegment["name"], alert?: RenderSegment["alert"]): RenderSegment => ({
		name,
		text: name,
		color: "accent",
		...(alert ? { alert } : {}),
	});
	const shared = renderPowerlineStatusline(300, [item("context"), item("tokens")], config);
	assert.equal(plain(shared), "░▒▓ context tokens");
	assert.equal(transitions(shared), 1);
	const split = renderPowerlineStatusline(300, [item("context", true), item("tokens")], config);
	assert.equal(plain(split), "░▒▓ context tokens");
	assert.equal(transitions(split), 2);
});

test("context and subscription windows all alert at eighty percent", () => {
	const config = createDefaultConfig();
	config.segments = ["context", "five_hour", "weekly"];
	const render = (percent: number) => {
		const context = createMockContext({
			model: { id: "gpt-5.6-sol", provider: "openai-codex", contextWindow: 372_000 },
			getContextUsage: () => ({
				percent,
				tokens: Math.round(3_720 * percent),
				contextWindow: 372_000,
			}),
		});
		const window = {
			bucketId: "codex:primary",
			spent: 0,
			usedPercent: percent,
			windowMinutes: FIVE_HOURS,
			resetsAt: Date.now() / 1000 + 3600,
		};
		return renderStatusline(
			300,
			context.ctx,
			footerData,
			{} as Theme,
			config,
			runtimeWith({ providerId: "openai-codex", fiveHour: window, weekly: window }),
		);
	};
	const normal = render(0);
	for (const percent of [50, 79.9, 80, 95, 100]) {
		const rendered = render(percent);
		for (const text of ["◔", "◒", "◑"]) {
			const colors = colorsOf(normal, text);
			assert.deepEqual(
				colorsOf(rendered, text),
				percent >= 80 ? { fg: colors.bg, bg: colors.fg } : colors,
			);
		}
	}
});

test("cache inverts at or below fifty percent and stays hidden without prompt tokens", () => {
	const config = createDefaultConfig();
	config.segments = ["cache"];
	const render = (cacheRead: number, input: number, cacheWrite = 0) => {
		const context = createMockContext({
			sessionManager: {
				getEntries: () => [
					{
						type: "message",
						message: {
							role: "assistant",
							usage: {
								input,
								output: 0,
								cacheRead,
								cacheWrite,
								totalTokens: input + cacheRead + cacheWrite,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
						},
					},
				],
			},
		});
		return renderStatusline(
			300,
			context.ctx,
			footerData,
			{} as Theme,
			config,
			runtimeWith(undefined),
		);
	};
	const normal = colorsOf(render(1000, 0), "⌁");
	for (const [read, input, write, alert] of [
		[0, 1000, 0, true],
		[499, 501, 0, true],
		[500, 500, 0, true],
		[501, 499, 0, false],
		[1000, 0, 0, false],
		[500, 0, 500, true],
	] as const) {
		const rendered = render(read, input, write);
		assert.deepEqual(colorsOf(rendered, "⌁"), alert ? { fg: normal.bg, bg: normal.fg } : normal);
	}
	assert.equal(render(0, 0), "");
});
