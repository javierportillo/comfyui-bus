import test from "node:test";
import assert from "node:assert/strict";
import { computeLayout, resolveMember, uniqueName } from "../web/bus_model.js";

const m = (uid, name = uid, type = "IMAGE") => ({ uid, name, type });
const slot = (uid, kind, extra = {}) => ({ ...m(uid), kind, inputLinked: false, outputLinked: false, ...extra });

test("layout order: inherited, own, orphans", () => {
	const l = computeLayout({
		inherited: [m("a"), m("b")], own: [m("x")],
		prev: [slot("o", "orphan", { outputLinked: true })], switching: false,
	});
	assert.deepEqual(l.slots.map(s => s.uid), ["a", "b", "x", "o"]);
});

test("upstream delete without switch: unplugged inherited dropped, plugged promoted to own", () => {
	const l = computeLayout({
		inherited: [m("a")], own: [],
		prev: [slot("a", "inherited"), slot("b", "inherited", { outputLinked: true }), slot("c", "inherited", { inputLinked: true })],
		switching: false,
	});
	assert.deepEqual(l.slots.map(s => s.uid), ["a", "c"]);
	assert.deepEqual(l.own.map(s => s.uid), ["c"]);
	assert.equal(l.orphaned, 0);
});

test("switch: name+type remap keeps wires, unmatched wired outputs orphan, unmatched override promoted", () => {
	const l = computeLayout({
		inherited: [m("n1", "image"), m("n2", "mask", "MASK")], own: [],
		prev: [
			slot("o1", "inherited", { name: "image", outputLinked: true }),
			slot("o2", "inherited", { name: "latent", type: "LATENT", outputLinked: true }),
			slot("o3", "inherited", { name: "model", type: "MODEL", inputLinked: true }),
			slot("o4", "inherited", { name: "vae", type: "VAE" }),
		],
		switching: true,
	});
	assert.deepEqual(l.remap, { o1: "n1" });
	assert.deepEqual(l.orphans.map(s => s.uid), ["o2"]);
	assert.deepEqual(l.own.map(s => s.uid), ["o3"]);
	assert.deepEqual(l.slots.map(s => s.uid), ["n1", "n2", "o3", "o2"]);
	assert.equal(l.orphaned, 1);
});

test("orphan is re-adopted when a matching member returns", () => {
	const l = computeLayout({
		inherited: [m("n1", "latent", "LATENT")], own: [],
		prev: [slot("o2", "orphan", { name: "latent", type: "LATENT", outputLinked: true })],
		switching: true,
	});
	assert.deepEqual(l.remap, { o2: "n1" });
	assert.equal(l.orphans.length, 0);
});

test("own member with same uid as inherited becomes inherited (override via wire)", () => {
	const l = computeLayout({ inherited: [m("a")], own: [m("a")], prev: [slot("a", "own")], switching: false });
	assert.deepEqual(l.slots.map(s => s.kind), ["inherited"]);
});

const node = (name, mode = 0) => ({ name, mode });
function env(buses) {
	return {
		source: n => buses[n.name].source,
		originOf: (n, uid) => buses[n.name].wires?.[uid] ?? null,
		kindOf: (n, uid) => buses[n.name].kinds?.[uid] ?? "inherited",
	};
}

test("resolve: override wins, else inherits through chain, own unwired is unfed", () => {
	const A = node("A"), B = node("B"), C = node("C");
	const buses = {
		A: { wires: { x: { node: "srcA", slot: 0 }, y: { node: "srcY", slot: 1 } }, kinds: { x: "own", y: "own" } },
		B: { source: { node: A }, wires: { x: { node: "ovr", slot: 0 } } },
		C: { source: { node: B }, kinds: { z: "own" } },
	};
	assert.deepEqual(resolveMember(C, "x", env(buses)).origin, { node: "ovr", slot: 0 });
	assert.deepEqual(resolveMember(C, "y", env(buses)).origin, { node: "srcY", slot: 1 });
	assert.equal(resolveMember(C, "z", env(buses)).error, "unfed");
});

test("resolve: muted publisher, missing source and cycles are errors", () => {
	const A = node("A", 2), B = node("B"), C = node("C"), D = node("D");
	const buses = {
		A: { wires: { x: { node: "s", slot: 0 } } },
		B: { source: { node: A } },
		C: { source: { error: "missing" } },
		D: { source: { node: B } },
	};
	buses.A.source = { node: D };
	assert.equal(resolveMember(B, "x", env(buses)).error, "muted");
	assert.equal(resolveMember(C, "x", env(buses)).error, "missing");
	A.mode = 0;
	buses.A.wires = {};
	assert.equal(resolveMember(B, "x", env(buses)).error, "cycle");
});

test("uniqueName", () => {
	assert.equal(uniqueName("image", ["image", "image_2"]), "image_3");
	assert.equal(uniqueName("mask", ["image"]), "mask");
});
