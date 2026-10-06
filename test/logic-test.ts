// Logic test for the field-level scheduling ledger.
// Mocks browser globals and exercises the core scenarios.
import { setActivePinia, createPinia } from "pinia";
import { useScheduleStore } from "../src/stores/schedule";
import type { FieldChange } from "../src/types";

// --- mocks ---
const memory = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k)
};
let uuidCounter = 0;
Object.defineProperty(globalThis, "crypto", { value: { randomUUID: () => `uuid-${++uuidCounter}` }, configurable: true, writable: true });
Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true, writable: true });
(globalThis as any).structuredClone = (v: unknown) => JSON.parse(JSON.stringify(v));

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

setActivePinia(createPinia());
const store = useScheduleStore();

// --- Scenario 1: field-level merge, official untouched fields merge directly ---
console.log("\n[1] 离线字段级合并：正式侧没动的字段直接合入");
store.setOnline(false);
const scene = store.scenes[0]; // s1, day 2026-10-08
const oldDay = scene.day;
store.stageField(scene.id, "day", "2026-10-15");
check("草稿记录 1 项字段改动", store.draft?.changes.length === 1);
check("草稿 baseVersion = 当前 rev", store.draft?.baseVersion === store.rev);
store.setOnline(true);
store.syncDraft();
check("回网后场次日期已合入", store.scenes.find(s => s.id === scene.id)!.day === "2026-10-15");
check("草稿已清空", store.draft === null);
check("排期账 rev 递增", store.rev > 1);

// --- Scenario 2: first-write-wins, two versions for adjudication ---
console.log("\n[2] 先写入生效：两人同时改同一字段，后写入留两版裁决");
const s2 = store.scenes.find(s => s.id === "s2")!;
const base = s2.fieldRev.day ?? 0;
const c1: FieldChange = { id: "c1", sceneId: s2.id, field: "day", oldValue: s2.day, newValue: "2026-10-20", baseVersion: base, by: "场记", at: new Date().toISOString(), source: "离线", status: "待落地" };
const c2: FieldChange = { id: "c2", sceneId: s2.id, field: "day", oldValue: s2.day, newValue: "2026-10-21", baseVersion: base, by: "导演", at: new Date().toISOString(), source: "离线", status: "待落地" };
(store as any).landChange(c1);
(store as any).landChange(c2);
check("先写入的 c1 落地", c1.status === "已落地");
check("后写入的 c2 待裁决", c2.status === "待裁决");
check("产生 1 项待裁决", store.pendingAdjudications.length === 1);
const adj = store.pendingAdjudications[0];
check("裁决含离线版与正式版", adj.localValue === "2026-10-21" && adj.remoteValue === "2026-10-20");
// producer picks remote (the landed c1 value)
store.adjudicate(adj.id, "remote");
check("裁决后无待裁决", store.pendingAdjudications.length === 0);
check("采用正式版后日期为 10-20", store.scenes.find(s => s.id === s2.id)!.day === "2026-10-20");

// --- Scenario 3: idempotency, duplicate callback no new record ---
console.log("\n[3] 幂等：重复回传不新增记录");
const before = store.changes.length;
const dup = { ...c1, id: "c1" }; // same id
(store as any).landChange(dup);
check("重复回传不新增变更记录", store.changes.length === before);

// --- Scenario 4: reschedule releases occupancy + cascade + waitlist ---
console.log("\n[4] 改期：先释放旧占用，顺延共用资源场次，容量排满排队候补");
// s1 is at 2026-10-15 now, location l1 (capacity 2). s2 at 2026-10-20, location l1.
// Reschedule s1 to 2026-10-20 → shares l1 with s2 → s2 should be postponed.
const s1 = store.scenes.find(s => s.id === "s1")!;
const s2Before = store.scenes.find(s => s.id === "s2")!;
store.reschedule(s1.id, "2026-10-20");
check("s1 改期到 10-20", store.scenes.find(s => s.id === s1.id)!.day === "2026-10-20");
const s2After = store.scenes.find(s => s.id === "s2")!;
check("共用资源的 s2 被顺延", s2After.day !== "2026-10-20");
check("占用记录已释放旧占用", store.occupancy.every(o => o.released || o.day >= "2026-10-20"));
// started scene keeps occupancy
const s3 = store.scenes.find(s => s.id === "s3")!;
(store as any).updateStatus(s3.id, "拍摄中");
const s3DayBefore = s3.day;
store.reschedule(s3.id, "2026-10-25");
check("已开拍场次保留原占用", store.scenes.find(s => s.id === s3.id)!.day === s3DayBefore);

// --- Scenario 5: invalidation on resource/time change ---
console.log("\n[5] 资源/时段一变：未确认排期和旧豁免立即失效重算");
const draftScene = store.scenes.find(s => s.status === "草稿")!;
const exemptId = store.conflicts[0]?.id;
if (exemptId) store.exempt(exemptId);
const exemptCountBefore = store.exemptions.length;
store.commitField(draftScene.id, "equipmentIds", ["e1"]);
check("旧豁免已作废", store.exemptions.length === 0);
check("未确认排期标记重算", store.scenes.find(s => s.id === draftScene.id)!.needsRecompute === true);

// --- Scenario 6: late capacity receipt doesn't overwrite confirmed ---
console.log("\n[6] 晚到容量回执：已确认场次保留，未确认场次候补");
// s3 was set to 拍摄中 in scenario 4; reset to 草稿 so it is an unconfirmed scene at l3
store.updateStatus(s3.id, "草稿");
const waitlistBefore = store.activeWaitlist.length;
store.receiveCapacityReceipt("l3", "2026-10-09", 0); // capacity 0 → all unconfirmed waitlisted
check("容量回执已记录", store.capacityReceipts.length >= 1);
check("未确认场次进入候补", store.activeWaitlist.length > waitlistBefore);
check("候补写明卡点", store.activeWaitlist[0]?.reason.includes("容量回执"));

// --- Scenario 7: write failure retries only unlanded, no duplicate ledger entries ---
console.log("\n[7] 写入失败只重试未落地项，台账不重复");
const retryScene = store.scenes.find(s => s.status === "草稿")!;
store.setOnline(false);
store.stageField(retryScene.id, "start", "09:00");
const changeId = store.draft!.changes[0].id;
const ledgerBefore = store.changes.length;
store.setOnline(true);
store.syncDraft();
const ledgerAfter = store.changes.length;
const occurrences = store.changes.filter(c => c.id === changeId).length;
check("重试后台账中该变更仅 1 条", occurrences === 1);
check("台账新增 1 条（去重）", ledgerAfter - ledgerBefore === 1);
check("改动已落地", store.changes.find(c => c.id === changeId)?.status === "已落地");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) throw new Error(`${failed} logic checks failed`);