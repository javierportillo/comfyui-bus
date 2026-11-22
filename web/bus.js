const { app } = window.comfyAPI.app;
import { MODE_NEVER, computeLayout, resolveMember, newUid, uniqueName } from "./bus_model.js";

const TYPE = "Bus";
const NONE = "(none)";
const RED = "#e04040";
const GREY = "#888888";
const LGraphNode = LiteGraph.LGraphNode;

// Scope: a bus is visible from its own graph and every enclosing graph.
function allGraphs() {
	const root = app.graph.rootGraph ?? app.graph;
	return [root, ...(root.subgraphs?.values() ?? [])];
}

function scopeGraphs(graph) {
	const chain = [graph];
	for (let parent; (parent = allGraphs().find(g => g._nodes.some(n => n.subgraph === chain.at(-1)))) && !chain.includes(parent);) chain.push(parent);
	return chain;
}

const busNodes = graph => graph._nodes.filter(n => n.type === TYPE);
const idOf = node => node.widgets[0].value;
const sourceOf = node => (node.widgets[1].value === NONE ? "" : node.widgets[1].value);

// null: no source. {node}: resolved. {error}: "missing" | "duplicate".
function findSource(node) {
	const id = sourceOf(node);
	if (!id) return null;
	for (const graph of scopeGraphs(node.graph)) {
		const matches = busNodes(graph).filter(n => n !== node && idOf(n) === id);
		if (matches.length === 1) return { node: matches[0] };
		if (matches.length > 1) return { error: "duplicate" };
	}
	return { error: "missing" };
}

function dependsOn(node, target) {
	for (const seen = new Set(); node && !seen.has(node); node = findSource(node)?.node) {
		if (node === target) return true;
		seen.add(node);
	}
	return false;
}

const env = {
	source: findSource,
	kindOf: (node, uid) => node.slotInfo().find(s => s.uid === uid)?.kind,
	originOf(node, uid) {
		const i = node.inputs.findIndex(s => s.name === uid);
		const link = i < 0 ? null : node.getInputLink(i);
		return link && { node: node.graph.getNodeById(link.origin_id), slot: link.origin_slot };
	},
};

function toast(severity, detail) {
	app.extensionManager.toast.add({ severity, summary: "Bus", detail, life: 6000 });
}

let syncTimer = null;
function scheduleSyncAll(delay = 0) {
	if (syncTimer) return;
	syncTimer = setTimeout(() => {
		syncTimer = null;
		if (app.configuringGraph) scheduleSyncAll(50);
		else syncAll();
	}, delay);
}

// Buses pasted together keep pointing at each other: a consumer follows its publisher's paste rename.
const pasteBatch = { buses: new Set(), renames: new Map() };
function trackPaste(bus, oldId, newId) {
	if (!pasteBatch.buses.size) {
		setTimeout(() => {
			for (const b of pasteBatch.buses) {
				const id = pasteBatch.renames.get(sourceOf(b));
				if (id) b.widgets[1].value = id;
			}
			pasteBatch.buses.clear();
			pasteBatch.renames.clear();
			scheduleSyncAll();
		});
	}
	pasteBatch.buses.add(bus);
	if (oldId && oldId !== newId) pasteBatch.renames.set(oldId, newId);
}

function syncAll() {
	const buses = allGraphs().flatMap(busNodes);
	for (let pass = 0, changed = true; changed && pass < 20; pass++) {
		changed = false;
		for (const bus of buses) changed = bus.sync() || changed;
	}
	for (const bus of buses) bus.refreshMarks();
	app.canvas?.setDirty(true, true);
}

function nodeIssues(bus) {
	const issues = [];
	const id = idOf(bus);
	const name = `Bus "${id || bus.title}"`;
	if (id && busNodes(bus.graph).some(n => n !== bus && idOf(n) === id)) issues.push(`${name}: duplicate id`);
	const source = findSource(bus);
	if (source?.error) issues.push(`${name}: source "${sourceOf(bus)}" is ${source.error}`);
	else if (source && dependsOn(source.node, bus)) issues.push(`${name}: source "${sourceOf(bus)}" forms a loop`);
	return issues;
}

// Every wired consumer of a bus output must resolve to a real upstream output.
function collectIssues() {
	const issues = [];
	for (const graph of allGraphs()) {
		for (const bus of busNodes(graph)) {
			issues.push(...nodeIssues(bus));
			bus.outputs.forEach((slot, i) => {
				const res = resolveMember(bus, slot.name, env);
				if (!res.error) return;
				for (const id of slot.links ?? []) {
					const link = graph.getLink(id);
					const node = graph.getNodeById(link.target_id);
					if (!node || node.type === TYPE || node.mode === MODE_NEVER) continue;
					issues.push(`${node.title} "${node.inputs[link.target_slot].name}": bus "${idOf(bus)}" member "${slot.label}" is ${res.error}`);
				}
			});
		}
	}
	return issues;
}

class BusNode extends LGraphNode {
	static title = "Bus";
	static category = "utils";
	serialize_widgets = true;

	constructor(title) {
		super(title);
		this.isVirtualNode = true;
		this.properties ??= {};
		this.properties.members = [];
		this.properties.orphans = [];
		this.addWidget("text", "id", "", value => this.onIdChanged(value));
		this.addWidget("combo", "source", NONE, () => this.onSourceChanged(), { values: () => this.sourceChoices() });
		this.addInput("+", "*");
		this.setSize([240, this.computeSize()[1]]);
	}

	onConfigure() {
		this.widgets[1].value ||= NONE;
		this.ensureUniqueId();
		scheduleSyncAll();
	}

	onAdded() {
		this.ensureUniqueId();
		scheduleSyncAll();
	}

	// Pasted or cloned buses get a suffixed id. Loading a workflow never renames.
	ensureUniqueId() {
		if (this.graph && !app.configuringGraph) {
			const id = idOf(this);
			const taken = busNodes(this.graph).filter(n => n !== this).map(idOf);
			if (id && taken.includes(id)) {
				const base = id.replace(/_\d+$/, "");
				this.widgets[0].value = uniqueName(base, [...taken, base]);
			}
			trackPaste(this, id, idOf(this));
		}
		this._lastId = idOf(this);
	}

	onRemoved() {
		scheduleSyncAll();
	}

	onIdChanged(id) {
		const buses = allGraphs().flatMap(busNodes);
		if (this._lastId && !buses.some(n => n !== this && idOf(n) === this._lastId)) {
			for (const bus of buses) if (sourceOf(bus) === this._lastId) bus.widgets[1].value = id;
		}
		this._lastId = id;
		scheduleSyncAll();
	}

	onSourceChanged() {
		this._switching = true;
		scheduleSyncAll();
	}

	sourceChoices() {
		const ids = scopeGraphs(this.graph).flatMap(busNodes).filter(n => n !== this && idOf(n) && !dependsOn(n, this)).map(idOf);
		return [NONE, ...new Set(ids)];
	}

	// One entry per output; the trailing "+" input has no entry.
	slotInfo() {
		const own = new Set(this.properties.members.map(m => m.uid));
		const orphans = new Set(this.properties.orphans.map(m => m.uid));
		return this.outputs.map(o => ({
			uid: o.name, name: o.label, type: o.type,
			kind: own.has(o.name) ? "own" : orphans.has(o.name) ? "orphan" : "inherited",
		}));
	}

	onConnectionsChange(slotType, slot, connected, link) {
		if (!this.graph || app.configuringGraph || this._syncing) return;
		if (slotType === LiteGraph.INPUT && connected && link && slot === this.outputs.length) this.addMember(link);
		scheduleSyncAll();
	}

	// A wire plugged into the trailing "+" slot becomes a permanent member.
	addMember(link) {
		const origin = this.graph.getNodeById(link.origin_id)?.outputs[link.origin_slot];
		const type = origin?.type ?? link.type;
		const name = uniqueName(origin?.label || origin?.name || type.toLowerCase(), this.slotInfo().map(s => s.name));
		const uid = newUid();
		const input = this.inputs[this.outputs.length];
		Object.assign(input, { name: uid, label: name, type });
		this.addOutput(uid, type).label = name;
		this.addInput("+", "*");
		this.properties.members.push({ uid, name, type });
		this.setSize([this.size[0], this.computeSize()[1]]);
	}

	// Brings slots in line with the source bus. Returns true if anything changed.
	sync() {
		const switching = this._switching;
		this._switching = false;
		const source = findSource(this);
		if (source?.error) return false;
		const inherited = source ? source.node.slotInfo().filter(s => s.kind !== "orphan").map(({ uid, name, type }) => ({ uid, name, type })) : [];
		const prev = this.slotInfo().map((s, i) => ({ ...s, inputLinked: this.isInputConnected(i), outputLinked: this.isOutputConnected(i) }));
		const layout = computeLayout({ inherited, own: this.properties.members, prev, switching });
		if (switching && (layout.matched || layout.orphaned)) toast("info", `${layout.matched} remapped, ${layout.orphaned} orphaned`);

		const sameOrder = layout.slots.length === prev.length && layout.slots.every((s, i) => s.uid === prev[i].uid);
		if (!sameOrder && !this.rebuild(layout)) return false;
		let changed = !sameOrder;
		layout.slots.forEach((s, i) => {
			if (this.outputs[i].label === s.name) return;
			this.outputs[i].label = this.inputs[i].label = s.name;
			changed = true;
		});
		this.properties.members = layout.own;
		this.properties.orphans = layout.orphans;
		return changed;
	}

	// Recreates the slots in the new order and rewires the surviving ones.
	rebuild(layout) {
		const graph = this.graph;
		const wired = new Map();
		for (let i = 0; i < this.outputs.length; i++) {
			const uid = layout.remap[this.inputs[i].name] ?? this.inputs[i].name;
			const origin = this.getInputLink(i);
			const targets = (this.outputs[i].links ?? []).map(id => graph.getLink(id));
			wired.set(uid, {
				origin: origin && { id: origin.origin_id, slot: origin.origin_slot },
				targets: targets.map(l => ({ id: l.target_id, slot: l.target_slot })),
			});
		}
		const kept = layout.slots.map(s => wired.get(s.uid));
		const endpoints = kept.flatMap(w => w ? [w.origin?.id, ...w.targets.map(t => t.id)] : []);
		if (endpoints.some(id => id != null && !graph.getNodeById(id))) {
			toast("warn", "Can't reorder members while wired to subgraph input/output nodes");
			return false;
		}

		this._syncing = true;
		for (let i = this.inputs.length - 1; i >= 0; i--) this.disconnectInput(i);
		for (let i = this.outputs.length - 1; i >= 0; i--) this.disconnectOutput(i);
		while (this.inputs.length) this.removeInput(0);
		while (this.outputs.length) this.removeOutput(0);
		for (const s of layout.slots) {
			this.addInput(s.uid, s.type).label = s.name;
			this.addOutput(s.uid, s.type).label = s.name;
		}
		this.addInput("+", "*");
		kept.forEach((w, i) => {
			if (w?.origin) graph.getNodeById(w.origin.id).connect(w.origin.slot, this, i);
			for (const t of w?.targets ?? []) this.connect(i, graph.getNodeById(t.id), t.slot);
		});
		this._syncing = false;
		this.setSize([this.size[0], this.computeSize()[1]]);
		return true;
	}

	refreshMarks() {
		this.slotInfo().forEach(({ uid, kind }, i) => {
			const failed = kind === "orphan" || resolveMember(this, uid, env).error;
			const color = failed ? RED : kind === "inherited" ? GREY : undefined;
			for (const slot of [this.inputs[i], this.outputs[i]]) Object.assign(slot, { color_on: color, color_off: color });
		});
		this.has_errors = nodeIssues(this).length > 0;
	}

	// Native frontend hook: where output `slot` really comes from, possibly through other buses/graphs.
	resolveVirtualOutput(slot) {
		const res = resolveMember(this, this.outputs[slot].name, env);
		return res.origin?.node ? res.origin : undefined;
	}

	moveMember(uid, delta) {
		const members = this.properties.members;
		const i = members.findIndex(m => m.uid === uid);
		const j = i + delta;
		if (i < 0 || j < 0 || j >= members.length) return;
		[members[i], members[j]] = [members[j], members[i]];
		syncAll();
	}

	// Deliberate removal: wires on this member and on every consumer are disconnected.
	deleteMember(uid) {
		const i = this.outputs.findIndex(o => o.name === uid);
		const count = this.outputs[i].links?.length ?? 0;
		if (count && !confirm(`${count} downstream connection${count > 1 ? "s" : ""} will be removed.`)) return;
		this.disconnectInput(i);
		this.disconnectOutput(i);
		this.properties.members = this.properties.members.filter(m => m.uid !== uid);
		this.properties.orphans = this.properties.orphans.filter(m => m.uid !== uid);
		syncAll();
	}

	renameMember(uid, event) {
		const member = this.properties.members.find(m => m.uid === uid);
		app.canvas.prompt("Member name", member.name, value => {
			const taken = this.slotInfo().filter(s => s.uid !== uid).map(s => s.name);
			member.name = uniqueName(value.trim() || member.name, taken);
			const i = this.outputs.findIndex(o => o.name === uid);
			this.outputs[i].label = this.inputs[i].label = member.name;
			syncAll();
		}, event);
	}

	getSlotMenuOptions(slot) {
		const info = this.slotInfo()[slot.slot];
		if (!info) return [];
		const options = [];
		const connected = slot.output ? this.isOutputConnected(slot.slot) : this.isInputConnected(slot.slot);
		if (connected) options.push({ content: "Disconnect Links", callback: () => (slot.output ? this.disconnectOutput(slot.slot) : this.disconnectInput(slot.slot)) });
		if (info.kind === "own") {
			options.push(
				{ content: "Rename", callback: (_v, _o, event) => this.renameMember(info.uid, event) },
				{ content: "Move up", callback: () => this.moveMember(info.uid, -1) },
				{ content: "Move down", callback: () => this.moveMember(info.uid, 1) },
			);
		}
		if (info.kind !== "inherited") options.push(null, { content: "Delete member", className: "danger", callback: () => this.deleteMember(info.uid) });
		return options;
	}

	getExtraMenuOptions(_canvas, options) {
		const source = findSource(this);
		const id = idOf(this);
		options.push(null);
		if (source?.node) options.push({ content: "Go to source bus", callback: () => this.goTo(source.node) });
		if (id) options.push({ content: "Select consumers", callback: () => this.selectConsumers(id) });
		if (this.properties.orphans.length) options.push({ content: "Remove all orphans", callback: () => this.removeOrphans() });
	}

	goTo(node) {
		if (node.graph !== app.canvas.graph) app.canvas.setGraph(node.graph);
		app.canvas.centerOnNode(node);
		app.canvas.selectNode(node);
	}

	selectConsumers(id) {
		app.canvas.deselectAll();
		for (const bus of allGraphs().flatMap(busNodes)) {
			if (sourceOf(bus) === id && bus.graph === app.canvas.graph) app.canvas.selectNode(bus, true);
		}
	}

	removeOrphans() {
		for (const { uid } of [...this.properties.orphans]) {
			const i = this.outputs.findIndex(o => o.name === uid);
			this.disconnectInput(i);
			this.disconnectOutput(i);
		}
		this.properties.orphans = [];
		syncAll();
	}
}

app.registerExtension({
	name: "comfyui-bus",
	registerCustomNodes() {
		LiteGraph.registerNodeType(TYPE, BusNode);
	},
	afterConfigureGraph() {
		scheduleSyncAll();
	},
	setup() {
		const graphToPrompt = app.graphToPrompt.bind(app);
		app.graphToPrompt = async (...args) => {
			syncAll();
			const issues = collectIssues();
			if (issues.length) {
				toast("error", issues.join("\n"));
				throw new Error(`Bus:\n${issues.join("\n")}`);
			}
			return graphToPrompt(...args);
		};
	},
});
