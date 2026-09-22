import assert from "node:assert/strict";
import { sep } from "node:path";
import type { ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { INFORMATION_PROFILES } from "../src/information-profiles.js";
import { powerlineExtensionSeparator, renderPowerlineStatusline } from "../src/powerline.js";
import { resolvePreset } from "../src/presets/index.js";
import { adaptTextColor } from "../src/presets/oklch.js";
import {
	formatConfiguredSegment,
	formatToolActivity,
	type RuntimeState,
	renderStatusline,
	truncateModel,
} from "../src/render.js";
import { createDefaultConfig, normalizeStatuslineConfig } from "../src/settings.js";
import {
	PALETTE_PRESET_NAMES,
	type RenderItem,
	type RenderSegment,
	SEGMENT_NAMES,
	type SegmentName,
} from "../src/types.js";

const ESCAPE = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESCAPE}\\[[0-9;]*m`, "gu");

function plain(value: string): string {
	return value.replace(ANSI_PATTERN, "");
}

function segment(name: SegmentName, text: string): RenderSegment {
	return { name, text, color: "accent" };
}

test("powerline renderer keeps configured segment order and colours by position", () => {
	const config = createDefaultConfig();
	const rendered = renderPowerlineStatusline(
		300,
		[segment("model", "model"), segment("time", "time"), segment("provider", "provider")],
		config,
	);
	assert.match(plain(rendered), /^░▒▓ model time provider$/u);
	// Tokyo Night's first three ramp colours, in row order regardless of segment name.
	assert.ok(rendered.includes("\u001b[38;2;9;12;12;48;2;163;174;210m model"));
	assert.ok(rendered.includes("\u001b[38;2;227;229;229;48;2;118;159;240m time"));
	assert.ok(rendered.includes("\u001b[38;2;118;159;240;48;2;57;66;96m provider"));
});

test("every theme starts a new row at the next background cycle in both overflow modes", () => {
	for (const palettePreset of PALETTE_PRESET_NAMES) {
		for (const overflow of ["wrap", "drop"] as const) {
			const config = createDefaultConfig();
			config.palettePreset = palettePreset;
			config.overflow = overflow;
			const items = INFORMATION_PROFILES.balanced.map((name) => segment(name, name));
			const rows = plain(renderPowerlineStatusline(1000, items, config)).split("\n");
			assert.equal(rows.length, 3, `${palettePreset}/${overflow}`);
			assert.match(rows[0] ?? "", /cwd.*model.*thinking.*context.*cost/u);
			assert.match(rows[1] ?? "", /branch.*tokens.*five_hour.*weekly.*cache/u);
			assert.match(rows[2] ?? "", /tools/u);
			assert.ok(!rows[0]?.includes("branch"));
			if (palettePreset !== "custom" && palettePreset !== "prism") {
				const output = renderPowerlineStatusline(1000, items, config).split("\n");
				const first = resolvePreset(palettePreset).ramp[0];
				assert.ok(first);
				assert.deepEqual(blockColors(output[1] ?? ""), first);
			}
		}
	}
});

test("single-color and empty custom ramps have well-defined cycle boundaries", () => {
	const config = createDefaultConfig();
	config.palettePreset = "custom";
	config.palette = [{ fg: "#000000", bg: "#ffffff" }];
	const items = [segment("model", "model"), segment("context", "context")];
	assert.equal(renderPowerlineStatusline(300, items, config).split("\n").length, 2);
	config.palette = [];
	assert.equal(renderPowerlineStatusline(300, items, config).split("\n").length, 1);
});

test("a ramp shorter than the row wraps before its first colour repeats", () => {
	const config = createDefaultConfig();
	config.palettePreset = "custom";
	config.palette = [
		{ fg: "#000000", bg: "#111111" },
		{ fg: "#000000", bg: "#222222" },
	];
	const rendered = renderPowerlineStatusline(
		300,
		[segment("cwd", "one"), segment("branch", "two"), segment("model", "three")],
		config,
	);
	assert.ok(rendered.includes("48;2;17;17;17m one"));
	assert.ok(rendered.includes("48;2;34;34;34m two"));
	assert.ok(rendered.includes("48;2;17;17;17m three"));
});

test("Tokyo Night default retains the exact powerline colors", () => {
	const rendered = renderPowerlineStatusline(
		300,
		[segment("model", "model")],
		createDefaultConfig(),
	);
	assert.equal(
		rendered,
		"\u001b[38;2;163;174;210m░▒▓\u001b[0m" +
			"\u001b[38;2;9;12;12;48;2;163;174;210m model\u001b[0m" +
			"\u001b[38;2;163;174;210m\u001b[0m",
	);
});

test("powerline colors fall back to ANSI-256 when true color is disabled", () => {
	const rendered = renderPowerlineStatusline(
		300,
		[segment("model", "model")],
		createDefaultConfig(),
		false,
	);
	assert.equal(rendered.includes("\u001b[38;2;"), false);
	assert.equal(rendered.includes("\u001b[48;2;"), false);
	assert.equal(rendered.includes("\u001b[38;5;146m"), true);
	assert.equal(rendered.includes("\u001b[38;5;16;48;5;146m"), true);
	assert.equal(plain(rendered), "░▒▓ model");
});

test("neighbours with identical ramp colours share one block", () => {
	const config = createDefaultConfig();
	config.palettePreset = "custom";
	config.palette = Array.from({ length: 2 }, () => ({ fg: "#090c0c", bg: "#a3aed2" }));
	const rendered = renderPowerlineStatusline(
		300,
		[segment("time", "time"), segment("brand", "brand")],
		config,
	);
	assert.equal(plain(rendered), "░▒▓ time brand");
	assert.equal((plain(rendered).match(//gu) ?? []).length, 1);
});

test("partial custom palette leaves omitted colors unstyled", () => {
	const config = normalizeStatuslineConfig({ palette: [{ fg: "#ffffff" }] }).config;
	const rendered = renderPowerlineStatusline(300, [segment("time", "time")], config);
	assert.equal(rendered, `░▒▓${ESCAPE}[38;2;255;255;255m time${ESCAPE}[0m`);
});

test("empty custom palette renders without ANSI color fallback", () => {
	const config = normalizeStatuslineConfig({ palette: [] }).config;
	const rendered = renderPowerlineStatusline(
		300,
		[segment("model", "model"), segment("cwd", "cwd")],
		config,
	);
	assert.equal(rendered, "░▒▓ model cwd");
	assert.equal(powerlineExtensionSeparator({} as Theme, "custom"), " • ");
});

test("different neighbouring colours keep the powerline transition", () => {
	const config = createDefaultConfig();
	config.palettePreset = "custom";
	config.palette = [
		{ fg: "#090c0c", bg: "#a3aed2" },
		{ fg: "#090c0c", bg: "#123456" },
	];
	const rendered = renderPowerlineStatusline(
		300,
		[segment("time", "time"), segment("brand", "brand")],
		config,
	);
	assert.equal(plain(rendered), "░▒▓ time brand");
});

test("wrapping carries segments that do not fit onto further rows", () => {
	const config = createDefaultConfig();
	config.palettePreset = "custom";
	config.palette = [
		{ fg: "#000000", bg: "#111111" },
		{ fg: "#000000", bg: "#222222" },
	];
	const items = [
		segment("cwd", "ONE"),
		segment("branch", "TWO"),
		segment("model", "THREE"),
		segment("context", "FOUR"),
	];
	// "░▒▓ ONE TWO" is 13 columns; adding " THREE" would need 20.
	const rendered = renderPowerlineStatusline(16, items, config);
	const rows = rendered.split("\n");
	assert.deepEqual(rows.map(plain), ["░▒▓ ONE TWO", "░▒▓ THREE FOUR"]);
	assert.ok(rows.every((row) => visibleWidth(row) <= 16));
	// Each row starts the ramp over.
	assert.ok(rows[0]?.includes("48;2;17;17;17m ONE"));
	assert.ok(rows[1]?.includes("48;2;17;17;17m THREE"));
	assert.ok(rows[1]?.includes("48;2;34;34;34m FOUR"));
});

test("wrapping leaves out a segment wider than the row and keeps explicit rows", () => {
	const config = createDefaultConfig();
	const rendered = renderPowerlineStatusline(
		10,
		[
			segment("cwd", "A VERY LONG SEGMENT"),
			segment("model", "FITS"),
			{ name: "line_break" },
			segment("branch", "NEXT"),
		],
		config,
	);
	assert.deepEqual(rendered.split("\n").map(plain), ["░▒▓ FITS", "░▒▓ NEXT"]);
});

test("line breaks render separated repeated markers as independent powerline rows", () => {
	const config = createDefaultConfig();
	const items: RenderItem[] = [
		segment("model", "model"),
		{ name: "line_break" },
		segment("cwd", "cwd"),
		{ name: "line_break" },
		segment("branch", "branch"),
	];
	const rendered = renderPowerlineStatusline(300, items, config);
	assert.deepEqual(plain(rendered).split("\n"), ["░▒▓ model", "░▒▓ cwd", "░▒▓ branch"]);
});

test("idle contextual activity rows collapse while explicit empty rows remain", () => {
	const config = createDefaultConfig();
	config.segments = ["model", "line_break", "tools", "line_break", "context"];
	const context = createMockContext({
		model: { id: "claude-sonnet-4", provider: "anthropic", contextWindow: 1000 },
		getContextUsage: () => ({ percent: 42, contextWindow: 1000 }),
	});
	const footerData: ReadonlyFooterDataProvider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		onBranchChange: () => () => undefined,
		getAvailableProviderCount: () => 1,
	};
	const runtime: RuntimeState = {
		turnCount: 0,
		activeTools: new Map(),
		isStreaming: false,
		thinkingLevel: "off",
		duplicateExtensions: [],
		extensionStatusIconAliases: new Map(),
	};
	const idle = plain(renderStatusline(300, context.ctx, footerData, {} as Theme, config, runtime));
	assert.deepEqual(idle.split("\n"), ["░▒▓ ✱ Sonnet 4", "░▒▓ ◔ 420 (42%)"]);

	runtime.isStreaming = true;
	const streaming = plain(
		renderStatusline(300, context.ctx, footerData, {} as Theme, config, runtime),
	);
	assert.deepEqual(streaming.split("\n"), [
		"░▒▓ ✱ Sonnet 4",
		"░▒▓ ◌ thinking",
		"░▒▓ ◔ 420 (42%)",
	]);

	config.segments = ["line_break", "model", "line_break"];
	const explicitEmptyRows = plain(
		renderStatusline(300, context.ctx, footerData, {} as Theme, config, runtime),
	);
	assert.deepEqual(explicitEmptyRows.split("\n"), ["", "░▒▓ ✱ Sonnet 4", ""]);
});

test("UI prompt activity sanitizes and bounds titles with kind-only fallbacks", () => {
	const runtime: RuntimeState = {
		turnCount: 0,
		activeTools: new Map([["read", 2]]),
		isStreaming: true,
		thinkingLevel: "off",
		duplicateExtensions: [],
		extensionStatusIconAliases: new Map(),
	};
	const kinds = ["select", "confirm", "input", "editor", "custom"] as const;
	for (const kind of kinds) {
		runtime.uiPrompt = { kind };
		assert.equal(formatToolActivity(runtime), `⌨ waiting for ${kind}`);
	}

	runtime.uiPrompt = {
		kind: "confirm",
		title: `Deploy\n\x1b[31mproduction\x1b[0m\u202e ${"界".repeat(30)}`,
	};
	const titled = formatToolActivity(runtime) ?? "";
	assert.equal(titled.includes("\n"), false);
	assert.equal(titled.includes(ESCAPE), false);
	assert.equal(titled.includes("\u202e"), false);
	assert.match(titled, /^⌨ waiting for confirm · Deploy production/u);
	assert.ok(visibleWidth(titled) <= visibleWidth("⌨ waiting for confirm · ") + 40);
	assert.match(titled, /…$/u);

	runtime.uiPrompt = { kind: "custom", title: "\x1b[31m\u202e" };
	assert.equal(formatToolActivity(runtime), "⌨ waiting for custom");

	runtime.uiPrompt = { kind: "input", title: `a${"\u0301".repeat(1_000)}` };
	const zeroWidthTitle = (formatToolActivity(runtime) ?? "").replace("⌨ waiting for input · ", "");
	assert.equal([...zeroWidthTitle].length, 256);
	assert.match(zeroWidthTitle, /…$/u);
	assert.ok(visibleWidth(zeroWidthTitle) <= 40);
});

test("cwd uses Starship repository and three-component directory defaults", () => {
	const config = createDefaultConfig();
	config.segments = ["cwd"];
	const context = createMockContext({
		cwd: "/home/alice/work/repository/src",
	});
	const footerData: ReadonlyFooterDataProvider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		onBranchChange: () => () => undefined,
		getAvailableProviderCount: () => 1,
	};
	const runtime: RuntimeState = {
		homeDir: "/home/alice",
		turnCount: 0,
		activeTools: new Map(),
		isStreaming: false,
		thinkingLevel: "off",
		gitStatus: {
			root: "/home/alice/work/repository",
			ahead: 0,
			behind: 0,
			staged: 0,
			modified: 0,
			untracked: 0,
			conflicts: 0,
		},
		duplicateExtensions: [],
		extensionStatusIconAliases: new Map(),
	};

	assert.equal(
		plain(renderStatusline(300, context.ctx, footerData, {} as Theme, config, runtime)),
		"░▒▓ repository/src",
	);

	runtime.gitStatus = undefined;
	assert.equal(
		plain(renderStatusline(300, context.ctx, footerData, {} as Theme, config, runtime)),
		"░▒▓ work/repository/src",
	);

	(context.ctx as { cwd: string }).cwd = "/home/alice";
	runtime.gitStatus = {
		root: "/home/alice/",
		ahead: 0,
		behind: 0,
		staged: 0,
		modified: 0,
		untracked: 0,
		conflicts: 0,
	};
	assert.equal(
		plain(renderStatusline(300, context.ctx, footerData, {} as Theme, config, runtime)),
		"░▒▓ ~",
	);
});

test("cwd preserves POSIX backslashes and strips terminal controls", { skip: sep !== "/" }, () => {
	const config = createDefaultConfig();
	config.segments = ["cwd"];
	const context = createMockContext({ cwd: "/home/alice/team\\name/project" });
	const footerData: ReadonlyFooterDataProvider = {
		getGitBranch: () => null,
		getExtensionStatuses: () => new Map(),
		onBranchChange: () => () => undefined,
		getAvailableProviderCount: () => 1,
	};
	const runtime: RuntimeState = {
		homeDir: "/home/alice",
		turnCount: 0,
		activeTools: new Map(),
		isStreaming: false,
		thinkingLevel: "off",
		duplicateExtensions: [],
		extensionStatusIconAliases: new Map(),
	};

	assert.equal(
		plain(renderStatusline(300, context.ctx, footerData, {} as Theme, config, runtime)),
		"░▒▓ ~/team\\name/project",
	);
	(context.ctx as { cwd: string }).cwd =
		"/home/alice/team\x1b]8;;https://evil.example\x07click\x1b]8;;\x07/repo\nline";
	assert.equal(
		plain(renderStatusline(300, context.ctx, footerData, {} as Theme, config, runtime)),
		"░▒▓ ~/teamclick/repo line",
	);
	(context.ctx as { cwd: string }).cwd = "/home/alice/team/\x1bPhidden\x1b\\repo\u202e";
	assert.equal(
		plain(renderStatusline(300, context.ctx, footerData, {} as Theme, config, runtime)),
		"░▒▓ ~/team/repo",
	);
});

test("model truncation supports all directions before prefixes and responsive fitting", () => {
	const config = createDefaultConfig();
	config.segments = ["model"];
	config.segmentText.model.truncationLength = 6;
	const footerData: ReadonlyFooterDataProvider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		onBranchChange: () => () => undefined,
		getAvailableProviderCount: () => 1,
	};
	const runtime: RuntimeState = {
		turnCount: 0,
		activeTools: new Map(),
		isStreaming: false,
		thinkingLevel: "off",
		duplicateExtensions: [],
		extensionStatusIconAliases: new Map(),
	};
	const renderModel = (id: string) => {
		const context = createMockContext({ model: { id, provider: "llama.cpp" } });
		return plain(renderStatusline(300, context.ctx, footerData, {} as Theme, config, runtime));
	};

	config.segmentText.model.truncationDirection = "end";
	assert.equal(renderModel("abcdefghijklmno"), "░▒▓ ✱ abcdef…");
	config.segmentText.model.truncationDirection = "start";
	assert.equal(renderModel("abcdefghijklmno"), "░▒▓ ✱ …jklmno");
	config.segmentText.model.truncationDirection = "middle";
	assert.equal(renderModel("abcdefghijklmno"), "░▒▓ ✱ abc…mno");
	config.segmentText.model.truncationLength = 5;
	assert.equal(renderModel("abcdefghijklmno"), "░▒▓ ✱ abc…no");

	config.segmentText.model.truncationLength = 6;
	config.segmentText.model.truncationSymbol = "";
	assert.equal(renderModel("abcdefghijklmno"), "░▒▓ ✱ abcmno");
	config.segmentText.model.truncationLength = 0;
	assert.equal(renderModel("abcdefghijklmno"), "░▒▓ ✱ abcdefghijklmno");

	config.segmentText.model.truncationLength = 6;
	config.segmentText.model.truncationSymbol = "…";
	config.segmentText.model.truncationDirection = "end";
	assert.equal(renderModel("claude-sonnet-20241022"), "░▒▓ ✱ claude…");
	assert.equal(renderModel("A👨‍👩‍👧‍👦BCDEFG"), "░▒▓ ✱ A👨‍👩‍👧‍👦BCDE…");
});

test("model rendering strips terminal sequences from runtime IDs and truncation symbols", () => {
	assert.equal(
		truncateModel("safe\x1b]8;;https://evil.example\x07click\x1b]8;;\x07\nmodel", 0, "…", "end"),
		"safeclick model",
	);
	assert.equal(truncateModel("a\u009d0;title\u009cb", 0, "…", "end"), "ab");
	assert.equal(truncateModel("safe\x1bPpayload\x1b\\model\u202e", 0, "…", "end"), "safemodel");
	assert.equal(truncateModel("abcdef", 3, "\x1b[31m!\x1b[0m", "end"), "abc!");
	assert.equal(truncateModel("abcdef", 3, "\x1b_private\x1b\\!\u2066", "end"), "abc!");
});

test("default model truncation retains useful llama.cpp path detail at standard width", () => {
	const config = createDefaultConfig();
	const id = "/home/willow/program/llama.cpp/models/Qwen3.6-35B-A3B-UDT-Q4_K_XL_MTP.gguf";
	const model = { id, provider: "llama.cpp", contextWindow: 72_000 };
	const context = createMockContext({
		model,
		getContextUsage: () => ({ percent: 25.4, contextWindow: 72_000 }),
	});
	const footerData: ReadonlyFooterDataProvider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		onBranchChange: () => () => undefined,
		getAvailableProviderCount: () => 1,
	};
	const runtime: RuntimeState = {
		turnCount: 0,
		activeTools: new Map(),
		isStreaming: false,
		thinkingLevel: "off",
		duplicateExtensions: [],
		extensionStatusIconAliases: new Map(),
	};

	const rendered = plain(
		renderStatusline(80, context.ctx, footerData, {} as Theme, config, runtime),
	);
	assert.match(rendered, /✱ …Qwen3\.6-35B-A3B-UDT-Q4_K_XL_MTP\.gguf/u);
	assert.match(rendered, /⎇ main/u);
	assert.match(rendered, /◔ 18K \(25%\)/u);
	assert.ok(rendered.split("\n").every((row) => visibleWidth(row) <= 80));
	assert.equal(model.id, id);
});

test("responsive fitting keeps primary and active information ahead of decorative segments", () => {
	const config = createDefaultConfig();
	config.overflow = "drop";
	const items = [
		segment("brand", "BRAND"),
		segment("provider", "PROVIDER"),
		segment("model", "MODEL"),
		segment("thinking", "THINKING"),
		segment("cwd", "WORKSPACE"),
		segment("branch", "BRANCH"),
		segment("tools", "ACTIVE"),
		segment("context", "CONTEXT"),
		segment("tokens", "TOKENS"),
		segment("cache", "CACHE"),
		segment("cost", "COST"),
		segment("time", "TIME"),
		segment("turn", "TURN"),
	];

	// Keep this retention test within one cycle; cycle wrapping is tested separately.
	config.palettePreset = "custom";
	config.palette = Array.from(
		{ length: items.length },
		(_, index) => config.palette[index % 5] ?? {},
	);
	const normal = plain(renderPowerlineStatusline(60, items, config));
	assert.ok(visibleWidth(normal) <= 60);
	for (const value of ["MODEL", "WORKSPACE", "BRANCH", "ACTIVE", "CONTEXT"]) {
		assert.match(normal, new RegExp(value, "u"));
	}
	assert.doesNotMatch(normal, /BRAND|PROVIDER|CACHE|TOKENS|TIME|TURN/u);

	const narrow = plain(renderPowerlineStatusline(40, items, config));
	assert.ok(visibleWidth(narrow) <= 40);
	for (const value of ["MODEL", "BRANCH", "ACTIVE", "CONTEXT"]) {
		assert.match(narrow, new RegExp(value, "u"));
	}
	assert.doesNotMatch(narrow, /BRAND|PROVIDER|THINKING|WORKSPACE|CACHE|TOKENS|COST|TIME|TURN/u);
});

test("responsive fitting preserves explicit row boundaries and fits every rendered line", () => {
	const config = createDefaultConfig();
	config.overflow = "drop";
	const rendered = renderPowerlineStatusline(
		15,
		[
			segment("brand", "DECORATION"),
			segment("context", "CONTEXT"),
			{ name: "line_break" },
			segment("model", "MODEL"),
			segment("time", "CLOCK"),
		],
		config,
	);
	const lines = plain(rendered).split("\n");
	assert.equal(lines.length, 2);
	assert.match(lines[0] ?? "", /CONTEXT/u);
	assert.doesNotMatch(lines[0] ?? "", /DECORATION/u);
	assert.match(lines[1] ?? "", /MODEL/u);
	assert.doesNotMatch(lines[1] ?? "", /CLOCK/u);
	assert.ok(lines.every((line) => visibleWidth(line) <= 15));
});

test("responsive fitting removes one oversized segment and preserves empty explicit rows", () => {
	const config = createDefaultConfig();
	const oversized = renderPowerlineStatusline(8, [segment("model", "A VERY LONG MODEL")], config);
	assert.equal(oversized, "");

	const multiline = renderPowerlineStatusline(
		20,
		[{ name: "line_break" }, segment("model", "MODEL"), { name: "line_break" }],
		config,
	);
	const lines = multiline.split("\n");
	assert.equal(lines.length, 3);
	assert.equal(lines[0], "");
	assert.equal(lines[2], "");
	assert.ok(lines.every((line) => visibleWidth(line) <= 20));
});

test("density and separator configure text inside a contiguous block", () => {
	const config = createDefaultConfig();
	config.palettePreset = "custom";
	config.palette = Array.from({ length: 2 }, () => ({ fg: "#090c0c", bg: "#a3aed2" }));
	config.separator = "dot";
	config.density = "compact";
	assert.equal(
		plain(
			renderPowerlineStatusline(300, [segment("provider", "one"), segment("model", "two")], config),
		),
		"░▒▓ one • two",
	);
	config.density = "cozy";
	assert.equal(
		plain(
			renderPowerlineStatusline(300, [segment("provider", "one"), segment("model", "two")], config),
		),
		"░▒▓  one  •  two ",
	);
});

test("all named palettes render deterministic distinct ANSI output", () => {
	const outputs = new Set<string>();
	for (const palette of [
		"tokyo-night",
		"ocean",
		"sunset",
		"forest",
		"candy",
		"neon",
		"mono",
		"prism",
	] as const) {
		const config = createDefaultConfig();
		config.palettePreset = palette;
		config.palette = [{ fg: "#ffffff", bg: "#ffffff" }];
		const output = renderPowerlineStatusline(
			300,
			[segment("model", "model"), segment("cwd", "cwd")],
			config,
		);
		assert.equal(plain(output), "░▒▓ model cwd");
		outputs.add(output);
	}
	assert.equal(outputs.size, 8);
});

test("named palettes use cohesive preset-specific background ramps", () => {
	const expected = {
		ocean: ["#7dcfff", "#4f9fba", "#2d6f88", "#23475b", "#182b3a"],
		sunset: ["#ffcf70", "#f59e6f", "#dc718a", "#8f5b78", "#493447"],
		forest: ["#a7c080", "#83c092", "#5f9f75", "#3f6f55", "#293f35"],
		candy: ["#f5c2e7", "#cba6f7", "#89b4fa", "#745f9a", "#403a5c"],
		neon: ["#39ff14", "#00f5ff", "#ff4fd8", "#7a2cf3", "#29134f"],
		mono: ["#d4d4d4", "#a3a3a3", "#686868", "#404040", "#262626"],
		prism: ["#5a5a5a", "#4a4a4a", "#3a3a3a", "#2a2a2a", "#1a1a1a"],
	} as const;
	const samples = [
		segment("model", "model"),
		segment("cwd", "cwd"),
		segment("branch", "branch"),
		segment("tools", "tools"),
		segment("time", "time"),
	];

	for (const [palettePreset, colors] of Object.entries(expected)) {
		const config = createDefaultConfig();
		config.palettePreset = palettePreset as keyof typeof expected;
		const rendered = renderPowerlineStatusline(80, samples, config);
		const actual = [...rendered.matchAll(/48;2;(\d+);(\d+);(\d+)m [a-z]/gu)].map((match) =>
			rgbMatchToHex(match.slice(1, 4)),
		);
		assert.deepEqual(actual, colors, palettePreset);
	}
});

test("only Prism adapts approved field colors to contrast four without changing backgrounds", () => {
	const config = createDefaultConfig();
	config.palettePreset = "prism";
	const backgrounds = ["#5a5a5a", "#4a4a4a", "#3a3a3a", "#2a2a2a", "#1a1a1a"];
	const monoBackgrounds = ["#d4d4d4", "#a3a3a3", "#686868", "#404040", "#262626"];
	const expected: Partial<Record<SegmentName, string>> = {
		model: "#e77b92",
		thinking: "#e77b92",
		context: "#a2daf4",
		tokens: "#a2daf4",
		five_hour: "#dce58a",
		weekly: "#dce58a",
		cache: "#a582dd",
		cost: "#e8ce99",
	};
	for (const name of SEGMENT_NAMES) {
		for (let position = 0; position < 10; position++) {
			const items = [
				...Array.from({ length: position }, () => segment("cwd", "x")),
				segment(name, "target"),
			];
			const rendered = renderPowerlineStatusline(300, items, config);
			const start = rendered.lastIndexOf(`${ESCAPE}[`, rendered.indexOf(" target"));
			const colors = blockColors(rendered.slice(start));
			assert.ok(colors);
			assert.equal(colors.bg, backgrounds[position % 5]);
			const seed = expected[name];
			assert.equal(colors.fg, seed ? adaptTextColor(seed, colors.bg, 4) : "#f0f0f0");
			assert.ok(contrastRatio(colors.fg, colors.bg) >= 4);
			const mono = renderPowerlineStatusline(300, items, { ...config, palettePreset: "mono" });
			const monoStart = mono.lastIndexOf(`${ESCAPE}[`, mono.indexOf(" target"));
			assert.deepEqual(
				blockColors(mono.slice(monoStart)),
				{
					fg: position % 5 < 2 ? "#090c0c" : "#f0f0f0",
					bg: monoBackgrounds[position % 5],
				},
				"original Mono stays neutral for every field",
			);
		}
	}
});

test("Prism colors each lead glyph independently on every row", () => {
	const config = createDefaultConfig();
	config.palettePreset = "prism";
	const items = [segment("cwd", "cwd"), segment("model", "MODEL")];
	for (const trueColor of [true, false]) {
		const prefix = (
			trueColor ? ["2;58;58;58", "2;74;74;74", "2;90;90;90"] : ["5;59", "5;59", "5;102"]
		)
			.map((color, index) => `${ESCAPE}[38;${color}m${"░▒▓"[index]}${ESCAPE}[0m`)
			.join("");
		const rows = renderPowerlineStatusline(10, items, config, trueColor).split("\n");
		assert.equal(rows.length, 2);
		for (const row of rows) assert.ok(row.startsWith(prefix));
		assert.deepEqual(rows.map(plain), ["░▒▓ cwd", "░▒▓ MODEL"]);
	}
});

test("Prism keeps a field's hue after wrapping and leaves the preset ramp immutable", () => {
	const config = createDefaultConfig();
	config.palettePreset = "prism";
	const items = [segment("cwd", "cwd"), segment("model", "MODEL")];
	const before = renderPowerlineStatusline(300, items, config);
	const rows = renderPowerlineStatusline(10, items, config).split("\n");
	assert.equal(rows.length, 2);
	assert.deepEqual(blockColors(rows[1] ?? ""), {
		fg: adaptTextColor("#E77B92", "#5a5a5a", 4),
		bg: "#5a5a5a",
	});
	assert.equal(renderPowerlineStatusline(300, items, config), before);
});

test("named palette block text meets WCAG AA contrast", () => {
	const samples = [
		segment("model", "model"),
		segment("cwd", "cwd"),
		segment("branch", "branch"),
		segment("tools", "tools"),
		segment("time", "time"),
	];

	for (const palettePreset of ["ocean", "sunset", "forest", "candy", "neon", "mono"] as const) {
		const config = createDefaultConfig();
		config.palettePreset = palettePreset;
		for (const item of samples) {
			const rendered = renderPowerlineStatusline(80, [item], config);
			const colors = blockColors(rendered);
			assert.ok(colors, `${palettePreset} ${item.name} colors`);
			assert.ok(
				contrastRatio(colors.fg, colors.bg) >= 4.5,
				`${palettePreset} ${item.name} contrast`,
			);
		}
	}
});

function blockColors(rendered: string): { fg: string; bg: string } | undefined {
	const match = /38;2;(\d+);(\d+);(\d+);48;2;(\d+);(\d+);(\d+)/u.exec(rendered);
	return match
		? { fg: rgbMatchToHex(match.slice(1, 4)), bg: rgbMatchToHex(match.slice(4, 7)) }
		: undefined;
}

function rgbMatchToHex(components: string[]): string {
	return `#${components
		.map((component) => Number(component).toString(16).padStart(2, "0"))
		.join("")}`;
}

function contrastRatio(left: string, right: string): number {
	const luminances = [left, right].map(relativeLuminance);
	const lighter = Math.max(...luminances);
	const darker = Math.min(...luminances);
	return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(hex: string): number {
	const channels = hex
		.slice(1)
		.match(/../gu)
		?.map((component) => Number.parseInt(component, 16) / 255)
		.map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)) ?? [
		0, 0, 0,
	];
	return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

test("the cache segment appends whole minutes since the latest response and hides them under a minute", () => {
	const config = createDefaultConfig();
	config.segments = ["cache"];
	const render = (timestamp: number) => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					timestamp,
					usage: {
						input: 200,
						output: 10,
						cacheRead: 800,
						cacheWrite: 0,
						totalTokens: 1010,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			},
		];
		const context = createMockContext({
			sessionManager: { getEntries: () => entries, getBranch: () => entries },
		});
		const footerData: ReadonlyFooterDataProvider = {
			getGitBranch: () => null,
			getExtensionStatuses: () => new Map(),
			onBranchChange: () => () => undefined,
			getAvailableProviderCount: () => 1,
		};
		const runtime: RuntimeState = {
			turnCount: 0,
			activeTools: new Map(),
			isStreaming: false,
			thinkingLevel: "off",
			duplicateExtensions: [],
			extensionStatusIconAliases: new Map(),
		};
		return plain(renderStatusline(300, context.ctx, footerData, {} as Theme, config, runtime));
	};

	const now = Date.now();
	assert.match(render(now - 30_000), /⌁ 80%/u);
	assert.doesNotMatch(render(now - 30_000), /\(/u);
	assert.match(render(now - 12 * 60_000), /⌁ 80% \(12m\)/u);
	assert.match(render(now - 95 * 60_000), /⌁ 80% \(1h 35m\)/u);
});

test("cache reports the latest response, not the session total, beside context and subscription", () => {
	const config = createDefaultConfig();
	config.segments = ["context", "cache", "tokens", "cost"];
	const makeUsage = (
		input: number,
		output: number,
		cacheRead: number,
		cacheWrite: number,
		cost: number,
	) => ({
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	});
	const latest = {
		type: "message",
		message: { role: "assistant", usage: makeUsage(11_000, 287, 0, 0, 0.03) },
	};
	const entries = [
		{
			type: "message",
			message: { role: "assistant", usage: makeUsage(700, 0, 4600, 1500, 0.025) },
		},
		{
			type: "message",
			message: { role: "toolResult", usage: makeUsage(100, 0, 0, 0, 0.005) },
		},
		{ type: "compaction", usage: makeUsage(100, 0, 0, 0, 0.005) },
		{ type: "branch_summary", usage: makeUsage(100, 0, 0, 0, 0.005) },
		latest,
	];
	const context = createMockContext({
		model: { id: "gpt-5", provider: "openai", contextWindow: 272_000 },
		modelRegistry: { isUsingOAuth: () => true },
		getContextUsage: () => ({ percent: 2.4, tokens: 6528, contextWindow: 272_000 }),
		sessionManager: { getEntries: () => entries, getBranch: () => [latest] },
	});
	const footerData: ReadonlyFooterDataProvider = {
		getGitBranch: () => null,
		getExtensionStatuses: () => new Map(),
		onBranchChange: () => () => undefined,
		getAvailableProviderCount: () => 1,
	};
	const runtime: RuntimeState = {
		turnCount: 0,
		activeTools: new Map(),
		isStreaming: false,
		thinkingLevel: "off",
		duplicateExtensions: [],
		extensionStatusIconAliases: new Map(),
		usage: { providerId: "openai" },
		dailySpent: { day: 0, providerId: "openai", dollars: 0.07 },
	};

	// The session totals 25% cache hits; the latest response read nothing from cache.
	assert.match(
		plain(renderStatusline(300, context.ctx, footerData, {} as Theme, config, runtime)),
		/◔ 6\.5K \(2%\)\u{e0b4} ⌁ 0%\u{e0b4} § ↑12K ↓287\u{e0b4} ☉ \$0\.07 \(sub\)/u,
	);
});

test("empty cache activity collapses its configured row and context falls back to model window", () => {
	const config = createDefaultConfig();
	config.segments = ["model", "line_break", "cache", "line_break", "context"];
	const context = createMockContext({
		model: { id: "claude-sonnet-4", provider: "anthropic", contextWindow: 200_000 },
		modelRegistry: { isUsingOAuth: () => false },
		getContextUsage: () => ({ percent: null, tokens: null, contextWindow: null }),
	});
	const footerData: ReadonlyFooterDataProvider = {
		getGitBranch: () => null,
		getExtensionStatuses: () => new Map(),
		onBranchChange: () => () => undefined,
		getAvailableProviderCount: () => 1,
	};
	const runtime: RuntimeState = {
		turnCount: 0,
		activeTools: new Map(),
		isStreaming: false,
		thinkingLevel: "off",
		duplicateExtensions: [],
		extensionStatusIconAliases: new Map(),
	};

	assert.deepEqual(
		plain(renderStatusline(300, context.ctx, footerData, {} as Theme, config, runtime)).split("\n"),
		["░▒▓ ✱ Sonnet 4", "░▒▓ ◔ ?"],
	);
});

test("Kimi subscription cost is marked while API-key cost is unchanged", () => {
	const config = createDefaultConfig();
	config.segments = ["cost"];
	const footerData: ReadonlyFooterDataProvider = {
		getGitBranch: () => null,
		getExtensionStatuses: () => new Map(),
		onBranchChange: () => () => undefined,
		getAvailableProviderCount: () => 1,
	};
	const runtime: RuntimeState = {
		turnCount: 0,
		activeTools: new Map(),
		isStreaming: false,
		thinkingLevel: "off",
		duplicateExtensions: [],
		extensionStatusIconAliases: new Map(),
	};
	const usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
	};
	const renderCost = (provider: string, oauth: boolean) => {
		runtime.dailySpent = { day: 0, providerId: provider, dollars: 0.01 };
		const context = createMockContext({
			model: { id: "model", provider },
			modelRegistry: { isUsingOAuth: () => oauth },
			sessionManager: {
				getEntries: () => [{ type: "message", message: { role: "assistant", usage } }],
				getBranch: () => [],
			},
		});
		return plain(renderStatusline(100, context.ctx, footerData, {} as Theme, config, runtime));
	};

	assert.match(renderCost("kimi-coding", false), /\$0\.01 \(sub\)/u);
	assert.doesNotMatch(renderCost("anthropic", false), /\(sub\)/u);
});

test("segment presentation wraps canonical dynamic values with configured text", () => {
	const config = createDefaultConfig();
	assert.equal(formatConfiguredSegment("provider", "anthropic", config), "⇄ anthropic");
	config.segmentText.provider = { prefix: "Provider[", suffix: "]" };
	assert.equal(formatConfiguredSegment("provider", "anthropic", config), "Provider[anthropic]");
	config.segmentText.cost = { prefix: "cost=", suffix: " USD" };
	assert.equal(formatConfiguredSegment("cost", "1.25", config), "cost=1.25 USD");
});

test("empty segment arrays render no powerline content", () => {
	assert.equal(renderPowerlineStatusline(80, [], createDefaultConfig()), "");
});
