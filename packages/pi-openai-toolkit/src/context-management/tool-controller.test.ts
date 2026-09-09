import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ContextManagementToolController, createContextManagementTools } from "./tools";
import { CodexContextWindowManager } from "./window-manager";

type Definition = {
	name: string;
	description: string;
	parameters: unknown;
	promptGuidelines?: string[];
};
const names = ["new_context", "get_context_remaining", "history", "notes"];

function harness(options: { autoActivate?: boolean; conflict?: string } = {}) {
	let active = ["read", "bash"];
	let loading = true;
	let unavailable = false;
	let updates = 0;
	const registry = new Map<string, Definition>();
	if (options.conflict) {
		registry.set(options.conflict, { name: options.conflict, description: "Another extension", parameters: {} });
		active.push(options.conflict);
	}
	const pi = {
		registerTool: (tool: Definition) => {
			if (registry.has(tool.name)) throw new Error("duplicate tool");
			registry.set(tool.name, tool);
			if (options.autoActivate !== false) active.push(tool.name);
		},
		getAllTools: () => {
			if (loading || unavailable) throw new Error("registry not ready");
			return [...registry.values()];
		},
		getActiveTools: () => {
			if (loading) throw new Error("actions unavailable during loading");
			return active;
		},
		setActiveTools: (next: string[]) => { active = next; updates++; },
	} as unknown as ExtensionAPI;
	const controller = new ContextManagementToolController(pi);
	const registered = controller.register(createContextManagementTools(pi, new CodexContextWindowManager(async () => undefined), () => false));
	loading = false;
	return {
		controller, registry, registered,
		get active() { return active; },
		get updates() { return updates; },
		setUnavailable(value: boolean) { unavailable = value; },
	};
}

test("disabled at startup hides tools Pi activated during registration", () => {
	const h = harness();
	expect(h.registered).toBe(true);
	expect(h.active).toEqual(["read", "bash", ...names]);
	expect(h.controller.sync(false)).toBe(true);
	expect(h.active).toEqual(["read", "bash"]);
});

test("enabled at startup can disable and re-enable without duplicates", () => {
	const h = harness();
	expect(h.controller.sync(true)).toBe(true);
	expect(h.updates).toBe(0);
	h.controller.sync(false);
	h.controller.sync(true);
	h.controller.sync(true);
	expect(h.active).toEqual(["read", "bash", ...names]);
	expect(h.updates).toBe(2);
});

test("initially inactive registrations follow explicit activation", () => {
	const h = harness({ autoActivate: false });
	h.controller.sync(false);
	expect(h.updates).toBe(0);
	h.controller.sync(true);
	expect(h.active).toEqual(["read", "bash", ...names]);
	h.controller.reset();
	expect(h.active).toEqual(["read", "bash"]);
	h.controller.sync(true);
	expect(h.active).toEqual(["read", "bash", ...names]);
});

test("a later foreign replacement is never removed and disables the partial runtime", () => {
	const h = harness();
	h.controller.sync(true);
	h.registry.set("notes", { name: "notes", description: "Foreign notes", parameters: {} });
	expect(h.controller.sync(true)).toBe(false);
	expect(h.controller.isRegistered).toBe(false);
	expect(h.active).toEqual(["read", "bash", "notes"]);
	h.controller.sync(false);
	expect(h.active).toEqual(["read", "bash", "notes"]);
});

test("partial registration failure removes only successfully owned tools", () => {
	const h = harness({ conflict: "history" });
	expect(h.registered).toBe(false);
	expect(h.active).toEqual(["read", "bash", "history", "new_context", "get_context_remaining"]);
	expect(h.controller.sync(true)).toBe(false);
	expect(h.active).toEqual(["read", "bash", "history"]);
});

test("temporary registry failure is retried rather than cached forever", () => {
	const h = harness();
	h.setUnavailable(true);
	expect(h.controller.sync(false)).toBe(false);
	expect(h.active).toEqual(["read", "bash", ...names]);
	h.setUnavailable(false);
	expect(h.controller.sync(false)).toBe(true);
	expect(h.active).toEqual(["read", "bash"]);
});
