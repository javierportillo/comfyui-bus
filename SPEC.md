# comfyui-bus spec

Standalone custom node pack. No core ComfyUI changes, no rgthree dependency. Frontend pinned at 1.58.5 (subgraphs, Vue nodes).

## Concept

One node type, **Bus**. A named, typed, ordered set of members that any downstream Bus can inherit remotely by id, override, and extend.

## Mechanism

- Frontend-only virtual node (like Set/Get). Python side only registers the node.
- Hook `app.graphToPrompt`: rewrite the prompt so consumers link straight to the real upstream outputs, then strip Bus nodes. Backend sees plain links: caching, validation, partial execution and API-format export all work.
- Reference: `comfyui-kjnodes/web/js/setgetnodes.js` (hook pattern). Avoid its bypass and cross-subgraph hacks.

## Node

- `id` (text): publish name. Optional.
- `source` (combo): bus id to inherit from. Optional. Lists ids visible in scope. Excludes self and ids that would form a loop.
- Dynamic inputs: trailing empty "+" slot. Plugging a wire creates a member.
- Outputs: one per member (inherited + own), same order as inputs.
- Inherited members: greyed input/output pair, upstream name and order. Input empty = pass-through. Plugging = override. Unplugging = revert to inherited (no revert action).
- Own members listed below inherited.

## Members

- Stable hidden `uid`; name and order are display-only. Inheritance and overrides match by uid.
- New member: named after source output label (dedupe `_2`), typed to the wire, appended last. `*` allowed until first connection.
- **Type locks permanently.** Different type = new member. No reset-type action.
- Rename: double-click label (own members only; inherited names come from upstream).
- Reorder: drag handle or context menu Move up/down (own members only).
- Inherited members can be hidden locally.
- A new downstream member gets its own uid even if the name matches an upstream one.

## Disconnect vs delete

- Unplugging a member input never removes the member. Value becomes empty, member is **unfed**.
- Unfed: red marker; wires on consumers stay. Queue-time error (naming bus and member) only if a consumer that executes uses it.
- **Delete member** (slot context menu) is the only removal. It disconnects wires on all downstream consumers. Other outputs keep their positions. Confirm only if N>0 downstream wires: "N downstream connections will be removed."

## Upstream changes vs downstream

- Upstream rename, reorder, add: flow down automatically.
- Upstream deletes a member that downstream had overridden (plugged): override becomes a local own member (keeps wire, name, order). Unplugged inherited member disappears downstream with its outputs disconnected.

## Switching `source` with existing wires

1. Remap inherited members to new source: uid first, then (name, type). Matched keep wires.
2. Unmatched outputs become **orphans**: red, greyed, wires kept. Unfed semantics apply.
3. Unmatched overrides become local own members (same as above).
4. Cleanup is deliberate: "Delete member" or node menu "Remove all orphans". Orphans keep uid and name and are re-adopted if a matching source returns.
5. No confirm on switch. Toast: "N remapped, M orphaned".

## Ids, scope, cycles

- Consumers store the publisher's id string, resolved internally to the publisher node. Renaming an id on the publisher updates consumers.
- Missing source id: red "missing bus" state, queue error.
- Duplicate ids in the same scope: red badge on both, queue error.
- Copy/paste/clone: members keep uids, pasted node's id gets `_2` suffix.
- Scope: own graph plus enclosing graphs (inward visibility only).
- Cycles (including loaded or edited workflows): queue-time error naming the nodes.

## Bypass / mute

- Muted or bypassed publisher: all its members unfed.
- Bypassed node feeding a member input: normal ComfyUI pass-through via the rewrite.
- Consumers follow their own mode. No special-casing.

## v1 extras

- Member color follows type color. "Jump to publisher" and "highlight consumers" buttons.
- Single queue-time error panel listing all unfed, missing, duplicate and cyclic issues at once.
- Shift-drag from a node's outputs adds several members at once.
- Works in subgraphs and API-format export.

## Later

Search/filter for large buses, value preview after a run, collapsible inherited section, diff view vs source.
