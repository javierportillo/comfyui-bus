// End-to-end test. Start ComfyUI first: python main.py --cpu --disable-all-custom-nodes --whitelist-custom-nodes comfyui-bus --port 8199
// Then: npm i playwright-core && node tests/browser.mjs (set executablePath below to your Chromium)
import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", e => errors.push("pageerror: " + e.message));
page.on("response", r => { if (r.status() === 404) errors.push("404 " + r.url()); });
page.on("console", m => { if (m.type() === "error" || m.text().includes("[bus]")) errors.push(m.type() + ": " + m.text()); });
await page.goto("http://127.0.0.1:8199/");
await page.waitForFunction(() => window.app?.graph && LiteGraph.registered_node_types?.Bus, null, { timeout: 60000 });

const result = await page.evaluate(async () => {
  const log = [];
  const ok = (name, cond, extra) => log.push(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : " " + JSON.stringify(extra)}`);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const g = app.graph;
  window.confirm = () => true;
  const mk = (type, x, y) => { const n = LiteGraph.createNode(type); n.pos = [x, y]; g.add(n); return n; };
  const slots = b => b.outputs.map(o => `${o.label}:${o.type}`);
  const prompt = async () => (await app.graphToPrompt()).output;

  const img = mk("EmptyImage", 0, 0), lat = mk("EmptyLatentImage", 0, 200), img2 = mk("EmptyImage", 0, 400);
  const A = mk("Bus", 400, 0); A.widgets[0].value = "main"; A.onIdChanged("main");
  img.connect(0, A, 0); await wait(100);
  ok("A member created from '+'", slots(A).join() === "IMAGE:IMAGE" && A.inputs.length === 2, slots(A));
  lat.connect(0, A, 1); await wait(100);
  ok("A second member", slots(A).join() === "IMAGE:IMAGE,LATENT:LATENT" && A.inputs.length === 3, slots(A));

  const B = mk("Bus", 800, 0); B.widgets[1].value = "main"; B.onSourceChanged(); await wait(100);
  ok("B inherits", slots(B).join() === "IMAGE:IMAGE,LATENT:LATENT", slots(B));
  const prev = mk("PreviewImage", 1200, 0);
  B.connect(0, prev, 0); await wait(50);
  let out = await prompt();
  ok("prompt resolves through chain", JSON.stringify(out[prev.id].inputs.images) === JSON.stringify([String(img.id), 0]), out[prev.id]);
  ok("bus nodes stripped from prompt", !Object.values(out).some(n => n.class_type === "Bus"), Object.keys(out));

  img2.connect(0, B, 0); await wait(100);
  out = await prompt();
  ok("override wins", out[prev.id].inputs.images[0] === String(img2.id), out[prev.id]);
  B.disconnectInput(0); await wait(100);
  out = await prompt();
  ok("unplug reverts", out[prev.id].inputs.images[0] === String(img.id), out[prev.id]);

  A.properties.members[0].name = "pic"; A.outputs[0].label = A.inputs[0].label = "pic"; syncAll_(); await wait(100);
  function syncAll_() { A.onIdChanged("main"); }
  ok("rename propagates", slots(B)[0] === "pic:IMAGE", slots(B));

  A.moveMember(A.properties.members[1].uid, -1); await wait(100);
  ok("move up reorders and keeps wires", slots(A).join() === "LATENT:LATENT,pic:IMAGE" && A.isInputConnected(0) && A.isInputConnected(1), slots(A));
  out = await prompt();
  ok("B follows order, prompt still resolves", slots(B).join() === "LATENT:LATENT,pic:IMAGE", slots(B));
  const previewLink = prev.getInputLink(0);
  ok("consumer wire stayed on image member", previewLink && B.outputs[previewLink.origin_slot].label === "pic", previewLink);

  // unfed
  A.disconnectInput(A.outputs.findIndex(o => o.label === "pic")); await wait(100);
  let threw = null; try { await app.graphToPrompt(); } catch (e) { threw = e.message; }
  ok("unfed member errors at queue", threw && threw.includes("unfed"), threw);
  ok("member survives disconnect", slots(A).length === 2, slots(A));
  img.connect(0, A, A.outputs.findIndex(o => o.label === "pic")); await wait(100);

  // delete cascade
  const picUid = A.properties.members.find(m => m.name === "pic").uid;
  A.deleteMember(picUid); await wait(100);
  ok("delete removes member downstream", slots(A).join() === "LATENT:LATENT" && slots(B).join() === "LATENT:LATENT", [slots(A), slots(B)]);
  ok("delete disconnects consumer", prev.getInputLink(0) == null);

  // switch source with wire kept via name match
  const C = mk("Bus", 400, 600); C.widgets[0].value = "alt"; C.onIdChanged("alt");
  const lat2 = mk("EmptyLatentImage", 0, 800); lat2.connect(0, C, 0); await wait(100);
  const lprev = mk("PreviewImage", 1200, 300);
  const sv = mk("VAEDecode", 1000, 300);
  B.connect(0, sv, 0); await wait(50);   // latent consumer (type mismatch irrelevant; wire exists)
  ok("latent consumer wired", sv.getInputLink(0) != null);
  B.widgets[1].value = "alt"; B.onSourceChanged(); await wait(150);
  ok("switch remaps by name+type", slots(B).join() === "LATENT:LATENT" && sv.getInputLink(0) != null, slots(B));
  const D = mk("Bus", 400, 900); D.widgets[0].value = "empty"; D.onIdChanged("empty");
  B.widgets[1].value = "empty"; B.onSourceChanged(); await wait(150);
  ok("switch to empty bus orphans wired member", B.slotInfo().map(s => s.kind).join() === "orphan" && sv.getInputLink(0) != null, B.slotInfo());
  B.widgets[1].value = "alt"; B.onSourceChanged(); await wait(150);
  ok("orphan re-adopted", B.slotInfo().map(s => s.kind).join() === "inherited" && sv.getInputLink(0) != null, B.slotInfo());
  B.widgets[1].value = "empty"; B.onSourceChanged(); await wait(150);
  B.removeOrphans(); await wait(100);
  ok("remove orphans disconnects", slots(B).length === 0 && sv.getInputLink(0) == null, slots(B));

  // duplicate id + id rename propagation
  C.onIdChanged("alt2"); await wait(100);
  B.widgets[1].value = "alt2"; B.onSourceChanged(); await wait(100);
  C.widgets[0].value = "alt3"; C.onIdChanged("alt3"); await wait(100);
  ok("id rename updates consumers", B.widgets[1].value === "alt3", B.widgets[1].value);
  D.widgets[0].value = "alt3"; D.onIdChanged("alt3"); await wait(100);
  threw = null; try { await app.graphToPrompt(); } catch (e) { threw = e.message; }
  ok("duplicate id errors", threw && threw.includes("duplicate"), threw);
  D.widgets[0].value = "empty"; D.onIdChanged("empty");

  // clone and paste
  const E = mk("Bus", 400, 1200); E.widgets[0].value = "orig"; E.onIdChanged("orig");
  const imgE = mk("EmptyImage", 0, 1200); imgE.connect(0, E, 0); await wait(100);
  const cl = E.clone(); g.add(cl); await wait(100);
  ok("clone keeps members, gets suffixed id", cl.widgets[0].value === "orig_2" && slots(cl).join() === slots(E).join(), [cl.widgets[0].value, slots(cl)]);
  const cl2 = cl.clone(); g.add(cl2); await wait(100);
  ok("cloning a suffixed id increments, no stacking", cl2.widgets[0].value === "orig_3", cl2.widgets[0].value);
  app.canvas.deselectAll(); app.canvas.selectNode(E); app.canvas.copyToClipboard();
  app.canvas.pasteFromClipboard({ connectInputs: false }); await wait(200);
  const ids = g._nodes.filter(n => n.type === "Bus").map(n => n.widgets[0].value);
  ok("paste works, gets unique id", ids.includes("orig_4"), ids);

  // copying a publisher with its consumer: the copy follows the copied publisher
  const P = mk("Bus", 400, 1500); P.widgets[0].value = "sec"; P.onIdChanged("sec");
  const imgP = mk("EmptyImage", 0, 1500); imgP.connect(0, P, 0); await wait(100);
  const Q = mk("Bus", 800, 1500); Q.widgets[1].value = "sec"; Q.onSourceChanged(); await wait(150);
  app.canvas.deselectAll(); app.canvas.selectNode(P); app.canvas.selectNode(Q, true); app.canvas.copyToClipboard();
  const beforePaste = new Set(g._nodes);
  app.canvas.pasteFromClipboard({ connectInputs: true }); await wait(300);
  const [P2, Q2] = g._nodes.filter(n => !beforePaste.has(n) && n.type === "Bus").sort((a, b) => a.pos[0] - b.pos[0]);
  ok("pasted consumer follows pasted publisher", P2.widgets[0].value === "sec_2" && Q2.widgets[1].value === "sec_2" && Q.widgets[1].value === "sec", [P2.widgets[0].value, Q2.widgets[1].value, Q.widgets[1].value]);
  ok("pasted consumer keeps its slots", slots(Q2).join() === slots(Q).join(), slots(Q2));
  const Q3 = Q.clone(); g.add(Q3); await wait(100);
  ok("consumer duplicated alone keeps original source", Q3.widgets[1].value === "sec", Q3.widgets[1].value);

  // serialization round trip
  const wf = app.graph.serialize();
  await app.loadGraphData(JSON.parse(JSON.stringify(wf)));
  await wait(500);
  const A2 = app.graph._nodes.find(n => n.type === "Bus" && n.widgets[0].value === "main");
  const B2 = app.graph._nodes.find(n => n.type === "Bus" && n.widgets[1].value === "alt3");
  ok("round trip keeps slots", A2 && slots(A2).join() === "LATENT:LATENT" && B2 && slots(B2).join() === "LATENT:LATENT", [A2 && slots(A2), B2 && slots(B2)]);
  ok("round trip keeps wires", A2.isInputConnected(0));
  return log;
});
console.log(result.join("\n"));
console.log("--- browser errors:\n" + errors.join("\n"));
await browser.close();
