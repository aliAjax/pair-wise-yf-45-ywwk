import type {
  Conflict,
  ConflictType,
  Exemption,
  FieldDispute,
  FieldOp,
  LedgerEntry,
  Receipt,
  Role,
  Scene,
  SceneField,
  WaitlistEntry
} from "../types";
import { equipmentNames, locationCapacity, locationName, talentNames } from "../data";

/** 排期账状态：所有写路径都经过这里，保证字段级版本与账本一致 */
export interface LedgerState {
  scenes: Scene[];
  ledger: LedgerEntry[];
  disputes: FieldDispute[];
  waitlist: WaitlistEntry[];
  exemptions: Exemption[];
  appliedOpIds: string[];
  /** 排期纪元：资源或时段一变就 +1，未确认排期与旧豁免据此失效重算 */
  epoch: number;
}

/** 时段字段成组：两边都改同一时段（哪怕不同子字段）也算撞单 */
export const TIME_FIELDS: SceneField[] = ["day", "start", "end"];
/** 会影响占用与豁免指纹的字段 */
export const EPOCH_FIELDS: SceneField[] = ["day", "start", "end", "locationId", "talentIds", "equipmentIds", "status"];

export const FIELD_LABELS: Record<SceneField, string> = {
  code: "场次编号",
  title: "场次名称",
  day: "拍摄日",
  start: "开始时间",
  end: "结束时间",
  locationId: "场地",
  talentIds: "演员",
  equipmentIds: "器材",
  status: "状态"
};

export function fieldGroup(field: SceneField): SceneField[] {
  return TIME_FIELDS.includes(field) ? TIME_FIELDS : [field];
}

/** 记录编辑发生时的基础版本（时段字段带上整组） */
export function captureBaseRevs(scene: Scene, field: SceneField): Partial<Record<SceneField, number>> {
  const revs: Partial<Record<SceneField, number>> = {};
  for (const item of fieldGroup(field)) revs[item] = scene.meta[item].rev;
  return revs;
}

export function formatFieldValue(field: SceneField, value: unknown): string {
  if (field === "locationId") return locationName(String(value));
  if (field === "talentIds") return talentNames(value as string[]).join("、") || "待定";
  if (field === "equipmentIds") return equipmentNames(value as string[]).join("、") || "无";
  if (Array.isArray(value)) return value.join("、");
  return String(value);
}

function minutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function timeOverlaps(aDay: string, aStart: string, aEnd: string, b: Scene): boolean {
  return aDay === b.day && minutes(aStart) < minutes(b.end) && minutes(b.start) < minutes(aEnd);
}

function shared(a: string[], b: string[]): string[] {
  return a.filter((value) => b.includes(value));
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 资源/时段指纹：豁免与未确认排期的有效性锚点 */
export function fingerprint(scene: Scene): string {
  return JSON.stringify([
    scene.day,
    scene.start,
    scene.end,
    scene.locationId,
    [...scene.talentIds].sort(),
    [...scene.equipmentIds].sort(),
    scene.status
  ]);
}

function conflictKey(a: Scene, b: Scene, type: ConflictType): string {
  return `${[a.id, b.id].sort().join(":")}:${type}`;
}

function conflictFps(a: Scene, b: Scene): string[] {
  return [fingerprint(a), fingerprint(b)].sort();
}

function isExempted(state: LedgerState, key: string, fps: string[]): boolean {
  return state.exemptions.some((item) => item.key === key && JSON.stringify(item.fps) === JSON.stringify(fps));
}

/** 冲突检测：覆盖全部场次，豁免按指纹匹配 */
export function detectConflicts(state: LedgerState): Conflict[] {
  const result: Conflict[] = [];
  const push = (a: Scene, b: Scene, type: ConflictType, message: string, severity: "高" | "中") => {
    const key = conflictKey(a, b, type);
    const fps = conflictFps(a, b);
    if (isExempted(state, key, fps)) return;
    result.push({ id: key, key, type, sceneIds: [a.id, b.id], message, severity, fps });
  };
  for (let i = 0; i < state.scenes.length; i += 1) {
    for (let j = i + 1; j < state.scenes.length; j += 1) {
      const a = state.scenes[i];
      const b = state.scenes[j];
      if (!timeOverlaps(a.day, a.start, a.end, b)) continue;
      const sharedTalents = shared(a.talentIds, b.talentIds);
      if (sharedTalents.length) push(a, b, "演员档期", `${talentNames(sharedTalents).join("、")} 在两场戏中档期重叠`, "高");
      if (a.locationId === b.locationId) push(a, b, "场地占用", `${locationName(a.locationId)} 被同时占用`, "高");
      const sharedEquipment = shared(a.equipmentIds, b.equipmentIds);
      if (sharedEquipment.length) push(a, b, "器材借用", `${equipmentNames(sharedEquipment).join("、")} 发生借用重叠`, "中");
      if (a.locationId !== b.locationId && Math.abs(minutes(b.start) - minutes(a.end)) < 30) {
        push(a, b, "转场时间", "两个场地之间转场时间不足30分钟", "中");
      }
    }
  }
  return result;
}

/** 已确认/拍摄中场次才持有占用；已开拍场次的占用任何路径都不能释放 */
export function occupancyBlockers(state: LedgerState, locationId: string, day: string, start: string, end: string, excludeId: string): Scene[] {
  return state.scenes.filter(
    (item) =>
      item.id !== excludeId &&
      item.locationId === locationId &&
      (item.status === "已确认" || item.status === "拍摄中") &&
      timeOverlaps(day, start, end, item)
  );
}

export interface ResourceClash {
  scene: Scene;
  sharedTalents: string[];
  sharedEquipment: string[];
}

/** 与已确认/拍摄中场次的演员、器材撞用检查 */
export function resourceClashes(
  state: LedgerState,
  day: string,
  start: string,
  end: string,
  talentIds: string[],
  equipmentIds: string[],
  excludeIds: string[]
): ResourceClash[] {
  const result: ResourceClash[] = [];
  for (const item of state.scenes) {
    if (excludeIds.includes(item.id)) continue;
    if (item.status !== "已确认" && item.status !== "拍摄中") continue;
    if (!timeOverlaps(day, start, end, item)) continue;
    const sharedTalents = shared(talentIds, item.talentIds);
    const sharedEquipment = shared(equipmentIds, item.equipmentIds);
    if (sharedTalents.length || sharedEquipment.length) result.push({ scene: item, sharedTalents, sharedEquipment });
  }
  return result;
}

function blockerText(state: LedgerState, locationId: string, day: string, start: string, end: string, excludeId: string): string {
  const parts: string[] = [];
  const blockers = occupancyBlockers(state, locationId, day, start, end, excludeId);
  const capacity = locationCapacity(locationId);
  if (blockers.length >= capacity) {
    const names = blockers.map((item) => `${item.code}（${item.status} ${item.start}–${item.end}）`).join("、");
    parts.push(`${locationName(locationId)} ${day} 容量 ${capacity} 已满：${names}`);
  }
  return parts.join("；");
}

function clashText(clashes: ResourceClash[]): string {
  return clashes
    .map((item) => {
      const what = [...talentNames(item.sharedTalents), ...equipmentNames(item.sharedEquipment)].join("、");
      return `与 ${item.scene.code}（${item.scene.status}）共用 ${what}`;
    })
    .join("；");
}

function fits(state: LedgerState, scene: Scene, day: string, extraExcludeIds: string[]): { ok: boolean; reason: string } {
  const blockers = occupancyBlockers(state, scene.locationId, day, scene.start, scene.end, scene.id);
  const capacity = locationCapacity(scene.locationId);
  if (blockers.length >= capacity) {
    return { ok: false, reason: blockerText(state, scene.locationId, day, scene.start, scene.end, scene.id) };
  }
  const clashes = resourceClashes(state, day, scene.start, scene.end, scene.talentIds, scene.equipmentIds, [scene.id, ...extraExcludeIds]);
  if (clashes.length) return { ok: false, reason: clashText(clashes) };
  return { ok: true, reason: "" };
}

function newOpId(): string {
  return crypto.randomUUID();
}

/** 字段落账：写值、升字段版本、记账、动纪元 */
function writeField(state: LedgerState, scene: Scene, field: SceneField, value: unknown, op: FieldOp): void {
  const baseRev = scene.meta[field].rev;
  const before = formatFieldValue(field, scene[field]);
  (scene as unknown as Record<string, unknown>)[field] = value;
  const at = new Date().toISOString();
  scene.meta[field] = { rev: baseRev + 1, role: op.role, opId: op.opId, at };
  state.ledger.unshift({
    id: crypto.randomUUID(),
    opId: op.opId,
    sceneId: scene.id,
    sceneCode: scene.code,
    field,
    baseRev,
    newRev: baseRev + 1,
    role: op.role,
    source: op.source,
    summary: `${FIELD_LABELS[field]} ${before} → ${formatFieldValue(field, value)}`,
    at
  });
  state.ledger = state.ledger.slice(0, 200);
  if (EPOCH_FIELDS.includes(field)) state.epoch += 1;
}

/**
 * 字段级合并入口。先写入的生效：后到操作基础版本对不上就留两版等制片裁决；
 * opId 幂等，重复回传不新增记录。
 */
export function applyOp(state: LedgerState, op: FieldOp): Receipt {
  if (state.appliedOpIds.includes(op.opId)) {
    return { op, result: "duplicate", detail: "回执已存在，重复回传不新增记录" };
  }
  const scene = state.scenes.find((item) => item.id === op.sceneId);
  if (!scene) return { op, result: "failed", detail: "场次不存在" };
  if (scene.locked) return { op, result: "failed", detail: "场次已锁定，写入被拒" };
  if (scene.status === "拍摄中" && op.field !== "status" && op.source !== "裁决") {
    return { op, result: "failed", detail: "已开拍场次保留原占用，拒绝改动资源与时段" };
  }
  const stale = fieldGroup(op.field).some((field) => scene.meta[field].rev !== (op.baseRevs[field] ?? scene.meta[field].rev));
  if (stale) {
    state.disputes.unshift({
      id: `disp-${op.opId}`,
      sceneId: scene.id,
      sceneCode: scene.code,
      field: op.field,
      official: { value: structuredClone(scene[op.field]), rev: scene.meta[op.field].rev, role: scene.meta[op.field].role, at: scene.meta[op.field].at },
      incoming: structuredClone(op),
      at: new Date().toISOString()
    });
    state.appliedOpIds.push(op.opId);
    return { op, result: "conflict", detail: "正式侧同一字段/时段已变更，留两版待制片裁决" };
  }
  if (sameValue(scene[op.field], op.value)) {
    state.appliedOpIds.push(op.opId);
    return { op, result: "applied", detail: "值相同，无需变更" };
  }
  if (op.field === "status" && op.value === "已确认") {
    const blockers = occupancyBlockers(state, scene.locationId, scene.day, scene.start, scene.end, scene.id);
    if (blockers.length >= locationCapacity(scene.locationId)) {
      return { op, result: "failed", detail: `${locationName(scene.locationId)} 容量已满，无法确认，可走改期候补` };
    }
  }
  writeField(state, scene, op.field, structuredClone(op.value), op);
  state.appliedOpIds.push(op.opId);
  return { op, result: "applied", detail: "已合入" };
}

export function makeOp(scene: Scene, field: SceneField, value: unknown, role: Role, source: FieldOp["source"]): FieldOp {
  return {
    opId: newOpId(),
    sceneId: scene.id,
    field,
    value: structuredClone(value),
    baseRevs: captureBaseRevs(scene, field),
    role,
    source,
    at: new Date().toISOString()
  };
}

function enqueueWaitlist(state: LedgerState, scene: Scene, candidateDays: string[], blocker: string): WaitlistEntry {
  const existing = state.waitlist.find((item) => item.sceneId === scene.id && item.status === "候补中");
  if (existing) {
    existing.candidateDays = [...candidateDays];
    existing.blocker = blocker;
    existing.epoch = state.epoch;
    return existing;
  }
  const entry: WaitlistEntry = {
    id: crypto.randomUUID(),
    sceneId: scene.id,
    sceneCode: scene.code,
    locationId: scene.locationId,
    start: scene.start,
    end: scene.end,
    candidateDays: [...candidateDays],
    blocker,
    epoch: state.epoch,
    status: "候补中",
    queuedAt: new Date().toISOString()
  };
  state.waitlist.unshift(entry);
  return entry;
}

function sharesResource(a: Scene, b: Scene): boolean {
  return a.locationId === b.locationId || shared(a.talentIds, b.talentIds).length > 0 || shared(a.equipmentIds, b.equipmentIds).length > 0;
}

/**
 * 改期：先释放旧占用，再按候选日期落位；共用资源的未确认场次跟着顺延；
 * 容量排满就排队候补并写明卡点。已开拍/已完成/锁定场次不动。
 */
export function rescheduleScene(state: LedgerState, sceneId: string, candidateDays: string[], role: Role): { logs: string[]; movedTo: string | null } {
  const logs: string[] = [];
  const scene = state.scenes.find((item) => item.id === sceneId);
  if (!scene) return { logs: ["场次不存在"], movedTo: null };
  if (scene.status === "拍摄中") return { logs: [`${scene.code} 已开拍，保留原占用，不参与改期`], movedTo: null };
  if (scene.status === "已完成") return { logs: [`${scene.code} 已完成，不再改期`], movedTo: null };
  if (scene.locked) return { logs: [`${scene.code} 已锁定，先解锁再改期`], movedTo: null };
  const days = candidateDays.map((item) => item.trim()).filter(Boolean);
  if (!days.length) return { logs: ["请至少给一个候选日期"], movedTo: null };

  const wasConfirmed = scene.status === "已确认";
  const originalDay = scene.day;
  if (wasConfirmed) {
    writeField(state, scene, "status", "草稿", makeOp(scene, "status", "草稿", role, "改期"));
    logs.push(`释放旧占用：${scene.code} ${originalDay} ${scene.start}–${scene.end} @${locationName(scene.locationId)}`);
  }

  let placed: string | null = null;
  let reason = "";
  for (const day of days) {
    const check = fits(state, scene, day, []);
    if (check.ok) {
      placed = day;
      break;
    }
    reason = reason || `${day} ${check.reason}`;
  }

  if (!placed) {
    enqueueWaitlist(state, scene, days, reason || "候选日期均不可用");
    logs.push(`容量排满：${scene.code} 排队候补，卡点：${reason || "候选日期均不可用"}`);
    return { logs, movedTo: null };
  }

  writeField(state, scene, "day", placed, makeOp(scene, "day", placed, role, "改期"));
  if (wasConfirmed) writeField(state, scene, "status", "已确认", makeOp(scene, "status", "已确认", role, "改期"));
  logs.push(`改期落位：${scene.code} → ${placed} ${scene.start}–${scene.end}`);

  // 顺延共用资源的未确认场次（原拍摄日、未锁定），跟随候选日期依次落位
  const cascaded = state.scenes
    .filter((item) => item.id !== scene.id && item.status === "草稿" && !item.locked && item.day === originalDay && sharesResource(item, scene))
    .sort((a, b) => a.start.localeCompare(b.start));
  const movedWith: string[] = [scene.id];
  for (const item of cascaded) {
    let cascadedTo: string | null = null;
    let cascadeReason = "";
    for (const day of days) {
      const check = fits(state, item, day, movedWith);
      if (check.ok) {
        cascadedTo = day;
        break;
      }
      cascadeReason = cascadeReason || `${day} ${check.reason}`;
    }
    if (cascadedTo) {
      writeField(state, item, "day", cascadedTo, makeOp(item, "day", cascadedTo, role, "顺延"));
      movedWith.push(item.id);
      logs.push(`顺延共用资源场次：${item.code} → ${cascadedTo}`);
    } else {
      enqueueWaitlist(state, item, days, cascadeReason || "候选日期均不可用");
      logs.push(`顺延受阻：${item.code} 排队候补，卡点：${cascadeReason}`);
    }
  }
  return { logs, movedTo: placed };
}

/**
 * 失效重算：资源或时段一变（纪元推进）就执行。
 * 1. 旧豁免指纹对不上立即失效；2. 候补上未确认排期重算，能转正就转正，否则刷新卡点。
 */
export function runRecompute(state: LedgerState): string[] {
  const logs: string[] = [];
  const raw = detectConflicts({ ...state, exemptions: [] });
  const valid = new Set(raw.map((item) => `${item.key}|${item.fps.join("|")}`));
  const kept = state.exemptions.filter((item) => valid.has(`${item.key}|${item.fps.join("|")}`));
  if (kept.length !== state.exemptions.length) {
    logs.push(`旧豁免失效 ${state.exemptions.length - kept.length} 项，冲突已重算`);
    state.exemptions = kept;
  }
  for (const entry of state.waitlist.filter((item) => item.status === "候补中")) {
    const scene = state.scenes.find((item) => item.id === entry.sceneId);
    if (!scene || scene.locked || scene.status === "拍摄中" || scene.status === "已完成") {
      entry.status = "已取消";
      logs.push(`候补取消：${entry.sceneCode}（场次状态已变化）`);
      continue;
    }
    let placed: string | null = null;
    let reason = "";
    for (const day of entry.candidateDays) {
      const check = fits(state, scene, day, []);
      if (check.ok) {
        placed = day;
        break;
      }
      reason = reason || `${day} ${check.reason}`;
    }
    if (placed) {
      writeField(state, scene, "day", placed, makeOp(scene, "day", placed, "制片", "候补转正"));
      if (scene.status === "草稿") writeField(state, scene, "status", "已确认", makeOp(scene, "status", "已确认", "制片", "候补转正"));
      entry.status = "已转正";
      logs.push(`候补转正：${scene.code} → ${placed}，占用重新落账`);
    } else if (reason !== entry.blocker || entry.epoch !== state.epoch) {
      entry.blocker = reason || "候选日期均不可用";
      entry.epoch = state.epoch;
      logs.push(`候补重算：${scene.code} 卡点更新为「${entry.blocker}」`);
    }
  }
  return logs;
}
