import { applyOp, makeOp, rescheduleScene, runRecompute, detectConflicts, type LedgerState } from "../src/ledger/engine";
import { seedScenes } from "../src/data";
import type { FieldOp } from "../src/types";

function freshStateForTest(): LedgerState {
  return { scenes: structuredClone(seedScenes), ledger: [], disputes: [], waitlist: [], exemptions: [], appliedOpIds: [], epoch: 1 };
}

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ok  ${name}`);
  else { failures += 1; console.error(`FAIL  ${name}`, extra ?? ""); }
}

const state = freshStateForTest();
const scene = (id: string) => state.scenes.find((s) => s.id === id)!;

// --- 1. 离线字段改动回网按字段合并：正式侧没动的直接合入 ---
// 场记基于 v1 改 s2 的拍摄日和器材（离线）
const s2 = scene("s2");
const draftDay: FieldOp = makeOp(s2, "day", "2026-10-10", "场记", "离线草稿");
const draftEquip: FieldOp = makeOp(s2, "equipmentIds", ["e2", "e3"], "场记", "离线草稿");
// 正式侧同时改了 s2 的开始时间（同一时段组）
applyOp(state, makeOp(s2, "start", "09:00", "制片", "在线"));
// 回网合并
let r = applyOp(state, draftDay);
check("两边都改同一时段 → 留两版待裁决", r.result === "conflict" && state.disputes.length === 1, r);
r = applyOp(state, draftEquip);
check("正式侧没动的器材字段直接合入", r.result === "applied" && JSON.stringify(scene("s2").equipmentIds) === '["e2","e3"]', r);
check("撞单字段未覆盖正式值", scene("s2").day === "2026-10-08" && scene("s2").start === "09:00");

// --- 2. 重复回传不新增记录 ---
const ledgerBefore = state.ledger.length;
const disputesBefore = state.disputes.length;
r = applyOp(state, draftDay);
check("重复回传撞单操作 → duplicate 且不新增记录", r.result === "duplicate" && state.disputes.length === disputesBefore && state.ledger.length === ledgerBefore, r);
r = applyOp(state, draftEquip);
check("重复回传已合入操作 → duplicate 不新增账本", r.result === "duplicate" && state.ledger.length === ledgerBefore, r);

// --- 3. 两人同时提交，先写入的生效 ---
const s3 = scene("s3");
const opA = makeOp(s3, "day", "2026-10-11", "制片", "在线");
const opB = makeOp(s3, "day", "2026-10-12", "导演", "在线");
applyOp(state, opA);
r = applyOp(state, opB);
check("先写入生效，后到留两版", scene("s3").day === "2026-10-11" && r.result === "conflict" && state.disputes.some((d) => d.sceneId === "s3"));

// --- 4. 裁决：采用离线版落账升版 ---
const dispute = state.disputes.find((d) => d.sceneId === "s3")!;
const ruling: FieldOp = { ...dispute.incoming, opId: "ruling-1", baseRevs: { day: scene("s3").meta.day.rev }, source: "裁决" };
r = applyOp(state, ruling);
check("裁决采用后到版落账", r.result === "applied" && scene("s3").day === "2026-10-12", r);

// --- 5. 改期：释放旧占用 → 候选日落位；容量满 → 候补写卡点；已开拍保留原占用 ---
const st2 = freshStateForTest();
// s1 已确认占老码头 10-08 08:00-11:30（容量1）；把 s1 改期到 10-09（s3 在候车厅，不挡）
let res = rescheduleScene(st2, "s1", ["2026-10-09"], "制片");
check("改期落位候选日", res.movedTo === "2026-10-09" && st2.scenes.find((s) => s.id === "s1")!.day === "2026-10-09", res.logs);
check("改期日志含释放旧占用", res.logs.some((l) => l.includes("释放旧占用")), res.logs);
// 再把 s1 改回 10-08 同时段：老码头容量1，自己释放后无占用 → 可落位；先造一个满员场景：
// 确认 s2（10-08 10:30-13:00 老码头）→ 与 s1(10-09) 不冲突，容量 ok
const s2b = st2.scenes.find((s) => s.id === "s2")!;
const confirmS2 = applyOp(st2, makeOp(s2b, "status", "已确认", "制片", "在线"));
check("容量允许时确认成功", confirmS2.result === "applied", confirmS2);
// 现在把 s1 改回 10-08：与 s2(已确认 10:30-13:00) 时段重叠 → 容量满 → 候补
res = rescheduleScene(st2, "s1", ["2026-10-08"], "制片");
check("容量排满 → 排队候补", res.movedTo === null && st2.waitlist.some((w) => w.sceneId === "s1" && w.status === "候补中"), res.logs);
check("候补写明卡点", st2.waitlist.find((w) => w.sceneId === "s1")!.blocker.includes("老码头"), st2.waitlist);
check("释放后未落位的场次保持草稿", st2.scenes.find((s) => s.id === "s1")!.status === "草稿");
// 已开拍场次保留原占用
const s2c = st2.scenes.find((s) => s.id === "s2")!;
applyOp(st2, makeOp(s2c, "status", "拍摄中", "制片", "在线"));
res = rescheduleScene(st2, "s2", ["2026-10-11"], "制片");
check("已开拍场次保留原占用不改期", res.movedTo === null && st2.scenes.find((s) => s.id === "s2")!.day === "2026-10-08", res.logs);
const r2 = applyOp(st2, makeOp(st2.scenes.find((s) => s.id === "s2")!, "day", "2026-10-11", "制片", "在线"));
check("已开拍场次字段写入被拒", r2.result === "failed", r2);

// --- 6. 资源/时段一变：旧豁免失效、候补重算转正 ---
// 豁免失效：用全新账本，s1(已确认 10-08 08:00-11:30 老码头) 与 s2(草稿 10:30-13:00 老码头) 场地冲突
const st4 = freshStateForTest();
const locConflict = detectConflicts(st4).find((c) => c.type === "场地占用" && c.sceneIds.includes("s1") && c.sceneIds.includes("s2"))!;
check("冲突可检出", !!locConflict);
st4.exemptions.push({ key: locConflict.key, fps: locConflict.fps, by: "制片", at: new Date().toISOString() });
check("豁免后冲突隐藏", !detectConflicts(st4).some((c) => c.key === locConflict.key));
// s2 器材一变 → 指纹失效 → 重算后豁免清除、冲突重现
applyOp(st4, makeOp(st4.scenes.find((s) => s.id === "s2")!, "equipmentIds", ["e4"], "制片", "在线"));
const logs4 = runRecompute(st4);
check("旧豁免失效重算", st4.exemptions.length === 0 && detectConflicts(st4).some((c) => c.key === locConflict.key), logs4);
// 候补转正：st2 中 s1 候补 10-08，s2 拍摄中改已完成 → 占用释放 → 重算转正
applyOp(st2, makeOp(st2.scenes.find((s) => s.id === "s2")!, "status", "已完成", "制片", "在线"));
const logs = runRecompute(st2);
check("候补自动转正并落账", st2.waitlist.find((w) => w.sceneId === "s1")!.status === "已转正" && st2.scenes.find((s) => s.id === "s1")!.status === "已确认", logs);

// --- 7. 顺延共用资源的场次 ---
const st3 = freshStateForTest();
// s2 与 s1 共用演员 t1 且同日同场地；s1 改期到 10-10 后老码头容量占满，s2(草稿) 应顺延到下一候选日 10-11
res = rescheduleScene(st3, "s1", ["2026-10-10", "2026-10-11"], "制片");
check("主场次改期落位", res.movedTo === "2026-10-10", res.logs);
check("共用资源草稿场次跟随顺延到下一候选日", st3.scenes.find((s) => s.id === "s2")!.day === "2026-10-11", res.logs);

console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
if (failures) throw new Error(`${failures} 项校验失败`);
