// Pure bus logic. No ComfyUI imports so it can be tested with plain node.

export const MODE_NEVER = 2;
export const MODE_BYPASS = 4;

export function newUid() {
	return Math.random().toString(36).slice(2, 10);
}

export function uniqueName(name, taken) {
	if (!taken.includes(name)) return name;
	let n = 2;
	while (taken.includes(`${name}_${n}`)) n++;
	return `${name}_${n}`;
}

// prev: current slots [{uid, name, type, kind: "inherited"|"own"|"orphan", inputLinked, outputLinked}]
// inherited: members of the source bus [{uid, name, type}]
// own: this bus' own members [{uid, name, type}]
// switching: the source was just changed by the user
// Returns the new slot order (inherited, own, orphans) plus what to do with existing wires:
// remap: old uid -> new uid (wires kept). Slots missing from the result lose their wires.
export function computeLayout({ inherited, own, prev, switching }) {
	const inheritedUids = new Set(inherited.map(m => m.uid));
	const claimed = new Set(prev.filter(s => inheritedUids.has(s.uid)).map(s => s.uid));
	const remap = {};
	const promoted = [];
	const orphans = [];
	let orphaned = 0;

	for (const s of prev) {
		if (s.kind === "own" || inheritedUids.has(s.uid)) continue;
		if (switching || s.kind === "orphan") {
			const match = inherited.find(m => !claimed.has(m.uid) && m.name === s.name && m.type === s.type);
			if (match) {
				remap[s.uid] = match.uid;
				claimed.add(match.uid);
				continue;
			}
		}
		const member = { uid: s.uid, name: s.name, type: s.type };
		if (s.inputLinked) promoted.push(member);
		else if ((switching || s.kind === "orphan") && s.outputLinked) {
			orphans.push(member);
			if (s.kind !== "orphan") orphaned++;
		}
	}

	const ownMembers = own.filter(m => !inheritedUids.has(m.uid)).concat(promoted);
	const slots = [
		...inherited.map(m => ({ ...m, kind: "inherited" })),
		...ownMembers.map(m => ({ ...m, kind: "own" })),
		...orphans.map(m => ({ ...m, kind: "orphan" })),
	];
	return { slots, own: ownMembers, orphans, remap, orphaned, matched: claimed.size };
}

// env.source(node) -> {node} | {error}   (null when the node has no source)
// env.originOf(node, uid) -> {node, slot} | null   (wire plugged into this bus' own input)
// env.kindOf(node, uid) -> "inherited" | "own" | "orphan"
// Returns {origin: {node, slot}} or {error}.
export function resolveMember(node, uid, env, seen = new Set()) {
	if (seen.has(node)) return { error: "cycle", nodes: [...seen] };
	seen.add(node);
	if (node.mode === MODE_NEVER || node.mode === MODE_BYPASS) return { error: "muted", nodes: [node] };
	const origin = env.originOf(node, uid);
	if (origin) return { origin };
	if (env.kindOf(node, uid) !== "inherited") return { error: "unfed", nodes: [node] };
	const source = env.source(node);
	if (!source) return { error: "unfed", nodes: [node] };
	if (source.error) return { error: source.error, nodes: [node] };
	return resolveMember(source.node, uid, env, seen);
}
