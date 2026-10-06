import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
import dayjs from "dayjs";
import type {
  Adjudication,
  CapacityReceipt,
  Conflict,
  Equipment,
  FieldChange,
  HistoryEntry,
  Location,
  Occupancy,
  OfflineDraft,
  ResourceType,
  Role,
  Scene,
  SceneStatus,
  Talent,
  Version,
  WaitlistEntry
} from "../types";

const STORAGE_KEY = "pair-wise-yf-45/schedule-v2";
const DRAFT_KEY = "pair-wise-yf-45/offline-draft-v2";

export const RESOURCE_FIELDS = new Set(["day", "start", "end", "locationId", "equipmentIds", "talentIds"]);

export const FIELD_LABELS: Record<string, string> = {
  day: "拍摄日",
  start: "开始时间",
  end: "结束时间",
  locationId: "场地",
  equipmentIds: "器材",
  talentIds: "演员",
  status: "状态"
};

const talents: Talent[] = [
  { id: "t1", name: "林川", role: "男主" },
  { id: "t2", name: "周禾", role: "女主" },
  { id: "t3", name: "顾言", role: "配角" },
  { id: "t4", name: "孙宁", role: "群演领队" }
];

const locations: Location[] = [
  { id: "l1", name: "老码头", capacity: 2 },
  { id: "l2", name: "玻璃厂房", capacity: 1 },
  { id: "l3", name: "南站候车厅", capacity: 1 }
];

const equipment: Equipment[] = [
  { id: "e1", name: "ARRI A机" },
  { id: "e2", name: "移动伸缩炮" },
  { id: "e3", name: "LED灯组" },
  { id: "e4", name: "跟拍车" }
];

const seedScenes: Scene[] = [
  { id: "s1", code: "A-012", title: "码头交接", day: "2026-10-08", start: "08:00", end: "11:30", talentIds: ["t1", "t3"], locationId: "l1", equipmentIds: ["e1", "e3"], status: "已确认", locked: false, fieldRev: {} },
  { id: "s2", code: "A-013", title: "厂房追逐", day: "2026-10-08", start: "10:30", end: "13:00", talentIds: ["t1", "t2"], locationId: "l1", equipmentIds: ["e2", "e4"], status: "草稿", locked: false, fieldRev: {} },
  { id: "s3", code: "B-021", title: "候车厅告别", day: "2026-10-09", start: "15:00", end: "18:30", talentIds: ["t2", "t3"], locationId: "l3", equipmentIds: ["e1"], status: "草稿", locked: false, fieldRev: {} }
];

function clone<T>(value: T): T {
  return value !== null && typeof value === "object" ? structuredClone(value) : value;
}

function minutes(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function overlaps(a: Scene, b: Scene) {
  return a.day === b.day && minutes(a.start) < minutes(b.end) && minutes(b.start) < minutes(a.end);
}

function shared(a: string[], b: string[]) {
  return a.some((value) => b.includes(value));
}

function sharesResource(a: Scene, b: Scene) {
  return a.locationId === b.locationId || shared(a.talentIds, b.talentIds) || shared(a.equipmentIds, b.equipmentIds);
}

interface PersistShape {
  rev: number;
  scenes: Scene[];
  history: HistoryEntry[];
  versions: Version[];
  changes: FieldChange[];
  adjudications: Adjudication[];
  waitlist: WaitlistEntry[];
  occupancy: Occupancy[];
  capacityReceipts: CapacityReceipt[];
  exemptions: string[];
  appliedKeys: string[];
}

function loadState(): PersistShape {
  const fallback: PersistShape = {
    rev: 1,
    scenes: structuredClone(seedScenes),
    history: [],
    versions: [],
    changes: [],
    adjudications: [],
    waitlist: [],
    occupancy: [],
    capacityReceipts: [],
    exemptions: [],
    appliedKeys: []
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PersistShape>;
    return {
      rev: parsed.rev ?? 1,
      scenes: parsed.scenes ?? fallback.scenes,
      history: parsed.history ?? [],
      versions: parsed.versions ?? [],
      changes: parsed.changes ?? [],
      adjudications: parsed.adjudications ?? [],
      waitlist: parsed.waitlist ?? [],
      occupancy: parsed.occupancy ?? [],
      capacityReceipts: parsed.capacityReceipts ?? [],
      exemptions: parsed.exemptions ?? [],
      appliedKeys: parsed.appliedKeys ?? []
    };
  } catch {
    return fallback;
  }
}

export const useScheduleStore = defineStore("schedule", () => {
  const initial = loadState();
  const rev = ref(initial.rev);
  const scenes = ref<Scene[]>(initial.scenes);
  const history = ref<HistoryEntry[]>(initial.history);
  const versions = ref<Version[]>(initial.versions);
  const changes = ref<FieldChange[]>(initial.changes);
  const adjudications = ref<Adjudication[]>(initial.adjudications);
  const waitlist = ref<WaitlistEntry[]>(initial.waitlist);
  const occupancy = ref<Occupancy[]>(initial.occupancy);
  const capacityReceipts = ref<CapacityReceipt[]>(initial.capacityReceipts);
  const exemptions = ref<string[]>(initial.exemptions);
  const appliedKeys = ref<Set<string>>(new Set(initial.appliedKeys));
  const role = ref<Role>("制片");
  const online = ref(navigator.onLine);
  const draft = ref<OfflineDraft | null>(null);

  const talentNames = (ids: string[]) => ids.map((id) => talents.find((item) => item.id === id)?.name ?? id);
  const locationName = (id: string) => locations.find((item) => item.id === id)?.name ?? id;
  const equipmentNames = (ids: string[]) => ids.map((id) => equipment.find((item) => item.id === id)?.name ?? id);

  const conflicts = computed<Conflict[]>(() => {
    const result: Conflict[] = [];
    for (let i = 0; i < scenes.value.length; i += 1) {
      for (let j = i + 1; j < scenes.value.length; j += 1) {
        const a = scenes.value[i];
        const b = scenes.value[j];
        if (!overlaps(a, b)) continue;
        const id = `${a.id}:${b.id}`;
        if (exemptions.value.includes(id)) continue;
        if (shared(a.talentIds, b.talentIds)) result.push({ id: `${id}:talent`, type: "演员档期", sceneIds: [a.id, b.id], message: `${talentNames(a.talentIds.filter((item) => b.talentIds.includes(item))).join("、")} 在两场戏中档期重叠`, severity: "高" });
        if (a.locationId === b.locationId) result.push({ id: `${id}:location`, type: "场地占用", sceneIds: [a.id, b.id], message: `${locationName(a.locationId)} 被同时占用`, severity: "高" });
        if (shared(a.equipmentIds, b.equipmentIds)) result.push({ id: `${id}:equipment`, type: "器材借用", sceneIds: [a.id, b.id], message: `${equipmentNames(a.equipmentIds.filter((item) => b.equipmentIds.includes(item))).join("、")} 发生借用重叠`, severity: "中" });
        if (a.locationId !== b.locationId && minutes(b.start) - minutes(a.end) < 30) result.push({ id: `${id}:transfer`, type: "转场时间", sceneIds: [a.id, b.id], message: "两个场地之间转场时间不足30分钟", severity: "中" });
      }
    }
    return result;
  });

  const sortedScenes = computed(() => [...scenes.value].sort((a, b) => `${a.day} ${a.start}`.localeCompare(`${b.day} ${b.start}`)));
  const pendingAdjudications = computed(() => adjudications.value.filter((item) => item.status === "待裁决"));
  const activeWaitlist = computed(() => waitlist.value.filter((item) => item.status === "候补中"));
  const landedChanges = computed(() => changes.value.filter((item) => item.status === "已落地"));

  function log(action: string, detail: string) {
    history.value.unshift({ id: crypto.randomUUID(), action, detail, time: new Date().toISOString() });
    history.value = history.value.slice(0, 120);
  }

  function persist() {
    const shape: PersistShape = {
      rev: rev.value,
      scenes: scenes.value,
      history: history.value,
      versions: versions.value,
      changes: changes.value,
      adjudications: adjudications.value,
      waitlist: waitlist.value,
      occupancy: occupancy.value,
      capacityReceipts: capacityReceipts.value,
      exemptions: exemptions.value,
      appliedKeys: [...appliedKeys.value]
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(shape));
  }

  watch([rev, scenes, history, versions, changes, adjudications, waitlist, occupancy, capacityReceipts, exemptions], persist, { deep: true });

  function fieldLabel(field: string) {
    return FIELD_LABELS[field] ?? field;
  }

  function describe(field: string, value: unknown): string {
    if (field === "day") return dayjs(String(value)).format("MM-DD");
    if (field === "locationId") return locationName(String(value));
    if (field === "equipmentIds") return equipmentNames((value as string[]) ?? []).join("、") || "无";
    if (field === "talentIds") return talentNames((value as string[]) ?? []).join("、") || "待定";
    if (Array.isArray(value)) return value.join("、");
    return String(value ?? "");
  }

  function lastWriterOf(scene: Scene, field: string): Role {
    const hit = changes.value.find((item) => item.sceneId === scene.id && item.field === field && item.status === "已落地");
    return hit?.by ?? "制片";
  }

  /**
   * 落地一条字段级变更（排期账唯一写入口）。
   * - 幂等：重复回传不新增记录
   * - 先写入生效：正式侧 fieldRev 已高于 baseVersion → 留两版待裁决
   * - 写入失败：状态保持「待落地」，由调用方只重试未落地项
   */
  /** 记账：变更按 id 去重，重试时更新已有记录而不是重复插入 */
  function recordChange(change: FieldChange) {
    const idx = changes.value.findIndex((item) => item.id === change.id);
    if (idx >= 0) changes.value[idx] = change;
    else changes.value.unshift(change);
  }

  function landChange(change: FieldChange, opts: { simulate?: boolean } = {}): FieldChange {
    // 幂等：重复回传不新增记录
    if (appliedKeys.value.has(change.id)) {
      log("重复回传", `变更 ${change.id.slice(0, 8)} 已落地，忽略`);
      return change;
    }
    const scene = scenes.value.find((item) => item.id === change.sceneId);
    if (!scene) {
      change.status = "已驳回";
      change.reason = "场次不存在";
      recordChange(change);
      return change;
    }
    const currentRev = scene.fieldRev[change.field] ?? 0;
    if (currentRev > change.baseVersion) {
      // 正式侧已先写入同字段 → 留两版等制片裁决
      change.status = "待裁决";
      change.reason = "正式侧已先写入同字段";
      const remoteValue = clone(scene[change.field as keyof Scene]);
      adjudications.value.unshift({
        id: crypto.randomUUID(),
        sceneId: change.sceneId,
        field: change.field,
        baseValue: change.oldValue,
        localValue: change.newValue,
        remoteValue,
        localBy: change.by,
        remoteBy: lastWriterOf(scene, change.field),
        createdAt: new Date().toISOString(),
        status: "待裁决"
      });
      recordChange(change);
      log("字段冲突待裁决", `${scene.code} ${fieldLabel(change.field)}：两边都改了同一字段，留两版等裁决`);
      return change;
    }
    // 模拟写入失败：每个批次第一次写入失败，重试只落地未落地项
    if (opts.simulate && writeAttempts === 0) {
      writeAttempts += 1;
      change.status = "待落地";
      change.reason = "写入失败，待重试";
      recordChange(change);
      log("写入失败", `${scene.code} ${fieldLabel(change.field)} 未落地，等待重试`);
      return change;
    }
    if (opts.simulate) writeAttempts += 1;
    // 落地
    (scene as Record<string, unknown>)[change.field] = clone(change.newValue);
    scene.fieldRev[change.field] = rev.value;
    change.landedRev = rev.value;
    change.status = "已落地";
    change.reason = undefined;
    appliedKeys.value.add(change.id);
    recordChange(change);
    log("字段落地", `${scene.code} ${fieldLabel(change.field)} → ${describe(change.field, change.newValue)}（v${change.landedRev}）`);
    // 重建该场次占用
    syncOccupancy(scene);
    // 资源/时段一变 → 未确认排期和旧豁免立即失效重算
    if (RESOURCE_FIELDS.has(change.field)) invalidateAndRecompute();
    rev.value += 1;
    return change;
  }

  let writeAttempts = 0;

  /** 在线字段编辑：直接走排期账落地 */
  function commitField(sceneId: string, field: string, newValue: unknown, by: Role = role.value): FieldChange | null {
    const scene = scenes.value.find((item) => item.id === sceneId);
    if (!scene) return null;
    const change: FieldChange = {
      id: crypto.randomUUID(),
      sceneId,
      field,
      oldValue: clone(scene[field as keyof Scene]),
      newValue: clone(newValue),
      baseVersion: scene.fieldRev[field] ?? 0,
      by,
      at: new Date().toISOString(),
      source: "在线",
      status: "待落地"
    };
    return landChange(change);
  }

  /** 离线字段编辑：按基础版本记入草稿，回网时按字段合并 */
  function stageField(sceneId: string, field: string, newValue: unknown) {
    const scene = scenes.value.find((item) => item.id === sceneId);
    if (!scene) return;
    if (!draft.value || draft.value.baseVersion !== rev.value) {
      draft.value = { baseVersion: rev.value, changes: [], savedAt: new Date().toISOString() };
    }
    const existing = draft.value.changes.find((item) => item.sceneId === sceneId && item.field === field && item.status === "待落地");
    if (existing) {
      // 同字段多次离线改动：合并为最新值，不新增记录
      existing.newValue = clone(newValue);
      existing.at = new Date().toISOString();
      log("更新离线改动", `${scene.code} ${fieldLabel(field)} → ${describe(field, newValue)}`);
    } else {
      draft.value.changes.push({
        id: crypto.randomUUID(),
        sceneId,
        field,
        oldValue: clone(scene[field as keyof Scene]),
        newValue: clone(newValue),
        baseVersion: draft.value.baseVersion,
        by: role.value,
        at: new Date().toISOString(),
        source: "离线",
        status: "待落地"
      });
      log("记录离线改动", `${scene.code} ${fieldLabel(field)} → ${describe(field, newValue)}（基础 v${draft.value.baseVersion}）`);
    }
    draft.value.savedAt = new Date().toISOString();
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft.value));
  }

  /** 回网：按字段合并，正式侧没动的字段直接合入，两边都改同一字段留两版裁决 */
  function syncDraft() {
    if (!draft.value) return;
    const pending = draft.value.changes.filter((item) => item.status === "待落地");
    if (!pending.length) {
      log("回网合并", "没有待回网的字段改动");
      return;
    }
    writeAttempts = 0;
    let landed = 0;
    let conflicts = 0;
    let retried = 0;
    // 第一批：模拟写入，可能失败
    for (const change of pending) {
      const result = landChange(change, { simulate: true });
      if (result.status === "已落地") landed += 1;
      else if (result.status === "待裁决") conflicts += 1;
    }
    // 重试：只重试未落地项，已落地的不重复回传
    for (let round = 0; round < 3; round += 1) {
      const stillPending = pending.filter((item) => item.status === "待落地");
      if (!stillPending.length) break;
      for (const change of stillPending) {
        const before = change.status;
        const result = landChange(change, { simulate: false });
        if (result.status === "已落地") {
          landed += 1;
          if (before === "待落地") retried += 1;
        } else if (result.status === "待裁决") conflicts += 1;
      }
    }
    // 清理已落地/已裁决的草稿改动
    draft.value.changes = draft.value.changes.filter((item) => item.status === "待落地");
    if (!draft.value.changes.length) {
      draft.value = null;
      localStorage.removeItem(DRAFT_KEY);
    } else {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft.value));
    }
    log("回网合并", `落地 ${landed} 项，裁决 ${conflicts} 项，重试 ${retried} 项（只重试未落地项）`);
  }

  /** 制片裁决：在两版中选一个，按裁决值落地 */
  function adjudicate(adjId: string, decision: "local" | "remote") {
    const adj = adjudications.value.find((item) => item.id === adjId);
    if (!adj || adj.status !== "待裁决") return;
    if (role.value !== "制片") {
      log("裁决被拒绝", "仅制片可裁决字段冲突");
      return;
    }
    const scene = scenes.value.find((item) => item.id === adj.sceneId);
    if (!scene) return;
    const value = decision === "local" ? adj.localValue : adj.remoteValue;
    const change: FieldChange = {
      id: crypto.randomUUID(),
      sceneId: adj.sceneId,
      field: adj.field,
      oldValue: clone(scene[adj.field as keyof Scene]),
      newValue: clone(value),
      baseVersion: scene.fieldRev[adj.field] ?? 0,
      by: role.value,
      at: new Date().toISOString(),
      source: "在线",
      status: "待落地"
    };
    landChange(change);
    adj.status = "已裁决";
    adj.decision = decision;
    adj.decidedAt = new Date().toISOString();
    log("字段裁决", `${scene.code} ${fieldLabel(adj.field)} → 采用${decision === "local" ? "离线版" : "正式版"}`);
  }

  /** 改期：先释放旧占用，再按候选日期顺延共用资源的场次；场地容量排满则排队候补 */
  function reschedule(sceneId: string, newDay: string) {
    const scene = scenes.value.find((item) => item.id === sceneId);
    if (!scene) return;
    if (scene.status === "拍摄中" || scene.status === "已完成") {
      log("改期被拒绝", `${scene.code} 已开拍，保留原占用`);
      return;
    }
    const oldDay = scene.day;
    if (oldDay === newDay) return;
    // 1. 释放旧占用
    releaseOccupancy(scene);
    log("释放旧占用", `${scene.code} ${oldDay} ${scene.start}-${scene.end}`);
    // 2. 改期场次落地（字段级）
    commitField(sceneId, "day", newDay);
    // 3. 场地容量检查：排满就排队候补，写明卡点
    const loc = locations.find((item) => item.id === scene.locationId);
    if (!venueHasCapacity(scene.locationId, newDay, scene.id)) {
      waitlist.value.unshift(makeWaitlist(scene, "场地", scene.locationId, `${loc?.name} 容量 ${loc?.capacity} 已排满（${newDay}），排队候补`));
      log("场地候补", `${scene.code} ${loc?.name} ${newDay} 卡点：容量排满`);
    }
    // 4. 按候选日期顺延共用资源的场次（已开拍保留原占用，不顺延）
    const candidates = buildCandidates(newDay, 6);
    for (const other of scenes.value) {
      if (other.id === sceneId) continue;
      if (other.status === "拍摄中" || other.status === "已完成") continue;
      if (!sharesResource(scene, other)) continue;
      if (other.day !== newDay) continue;
      const slot = findSlot(other, candidates);
      if (slot) {
        commitField(other.id, "day", slot);
        log("顺延共用资源", `${other.code} → ${slot}（与 ${scene.code} 共用资源）`);
      } else {
        waitlist.value.unshift(makeWaitlist(other, "场地", other.locationId, `改期顺延无候选日期（${newDay} 起 6 天内无空档），排队候补`));
        log("顺延候补", `${other.code} 卡点：${newDay} 起无候选日期`);
      }
    }
    // 5. 资源/时段一变 → 未确认排期和旧豁免立即失效重算
    invalidateAndRecompute();
  }

  function releaseOccupancy(scene: Scene) {
    for (const item of occupancy.value) {
      if (item.sceneId === scene.id && !item.released) item.released = true;
    }
  }

  function syncOccupancy(scene: Scene) {
    releaseOccupancy(scene);
    const types: { type: ResourceType; id: string }[] = [
      { type: "场地", id: scene.locationId },
      ...scene.talentIds.map((id) => ({ type: "演员" as ResourceType, id })),
      ...scene.equipmentIds.map((id) => ({ type: "器材" as ResourceType, id }))
    ];
    for (const t of types) {
      occupancy.value.push({
        id: crypto.randomUUID(),
        sceneId: scene.id,
        resourceType: t.type,
        resourceId: t.id,
        day: scene.day,
        start: scene.start,
        end: scene.end,
        released: false
      });
    }
  }

  function venueHasCapacity(locationId: string, day: string, excludeSceneId: string): boolean {
    const cap = locations.find((item) => item.id === locationId)?.capacity ?? 1;
    const atVenue = scenes.value.filter((item) => item.locationId === locationId && item.day === day && item.id !== excludeSceneId);
    let maxConcurrent = 0;
    for (const s of atVenue) {
      const concurrent = atVenue.filter((o) => o.id !== s.id && overlaps(s, o)).length;
      if (concurrent > maxConcurrent) maxConcurrent = concurrent;
    }
    return maxConcurrent < cap;
  }

  function buildCandidates(startDay: string, n: number): string[] {
    const start = dayjs(startDay);
    return Array.from({ length: n }, (_, i) => start.add(i, "day").format("YYYY-MM-DD"));
  }

  function findSlot(scene: Scene, candidates: string[]): string | null {
    for (const day of candidates) {
      const clash = scenes.value.some((other) => other.id !== scene.id && other.day === day && overlaps({ ...scene, day }, other));
      if (!clash) return day;
    }
    return null;
  }

  function makeWaitlist(scene: Scene, resourceType: ResourceType, resourceId: string, reason: string): WaitlistEntry {
    const resourceName =
      resourceType === "场地" ? locationName(resourceId) : resourceType === "演员" ? talentNames([resourceId]).join("、") : equipmentNames([resourceId]).join("、");
    return {
      id: crypto.randomUUID(),
      sceneId: scene.id,
      code: scene.code,
      title: scene.title,
      resourceType,
      resourceId,
      resourceName,
      day: scene.day,
      start: scene.start,
      end: scene.end,
      reason,
      status: "候补中",
      createdAt: new Date().toISOString()
    };
  }

  function cancelWaitlist(id: string) {
    const entry = waitlist.value.find((item) => item.id === id);
    if (!entry) return;
    entry.status = "已取消";
    log("取消候补", `${entry.code} ${entry.resourceName}`);
  }

  /** 容量回执晚到：已确认场次保留，未确认场次候补，不顶掉已确认 */
  function receiveCapacityReceipt(locationId: string, day: string, capacity: number) {
    const loc = locations.find((item) => item.id === locationId);
    const oldCap = loc?.capacity ?? 1;
    const receipt: CapacityReceipt = { id: crypto.randomUUID(), locationId, day, capacity, receivedAt: new Date().toISOString(), applied: false };
    capacityReceipts.value.unshift(receipt);
    if (capacity < oldCap) {
      const atVenue = scenes.value.filter((item) => item.locationId === locationId && item.day === day);
      let protectedCount = 0;
      for (const s of atVenue) {
        if (s.status === "已确认" || s.status === "拍摄中" || s.status === "已完成") {
          protectedCount += 1;
          continue;
        }
        if (!waitlist.value.some((w) => w.sceneId === s.id && w.status === "候补中")) {
          waitlist.value.unshift(makeWaitlist(s, "场地", locationId, `容量回执晚到：容量 ${oldCap} → ${capacity}，已确认场次保留，未确认场次候补`));
        }
      }
      log("容量回执", `${loc?.name} ${day} 容量 ${oldCap} → ${capacity}，已确认 ${protectedCount} 场保留，未确认候补`);
    } else {
      log("容量回执", `${loc?.name} ${day} 容量 ${oldCap} → ${capacity}，无需调整`);
    }
    receipt.applied = true;
  }

  /** 资源或时段一变：未确认排期和旧豁免立即失效重算 */
  function invalidateAndRecompute() {
    let recomputeCount = 0;
    for (const s of scenes.value) {
      if (s.status === "草稿" && !s.needsRecompute) {
        s.needsRecompute = true;
        recomputeCount += 1;
      }
    }
    const exemptCount = exemptions.value.length;
    exemptions.value = [];
    if (recomputeCount || exemptCount) {
      log("失效重算", `${recomputeCount} 个未确认排期标记重算，${exemptCount} 项旧豁免作废`);
    }
  }

  function addScene(input: Omit<Scene, "id" | "status" | "locked" | "fieldRev">) {
    scenes.value.push({ ...input, id: crypto.randomUUID(), status: "草稿", locked: false, fieldRev: {} });
    log("新增场次", `${input.code} ${input.title}`);
  }

  function updateStatus(id: string, status: SceneStatus) {
    const scene = scenes.value.find((item) => item.id === id);
    if (!scene || scene.locked) return;
    scene.status = status;
    log("流转状态", `${scene.code} → ${status}`);
  }

  function toggleLock(id: string) {
    const scene = scenes.value.find((item) => item.id === id);
    if (!scene) return;
    scene.locked = !scene.locked;
    log(scene.locked ? "锁定场次" : "解锁场次", scene.code);
  }

  function moveScene(from: number, to: number) {
    if (from === to || to < 0 || to >= scenes.value.length) return;
    const [item] = scenes.value.splice(from, 1);
    scenes.value.splice(to, 0, item);
    log("调整顺序", `${item.code} 移至第 ${to + 1} 位`);
  }

  function snapshot(name = `版本 ${versions.value.length + 1}`) {
    versions.value.unshift({ id: crypto.randomUUID(), name, time: new Date().toISOString(), rev: rev.value, scenes: structuredClone(scenes.value) });
    versions.value = versions.value.slice(0, 12);
    log("保存版本", `${name}（排期账 v${rev.value}）`);
  }

  function restore(id: string) {
    const version = versions.value.find((item) => item.id === id);
    if (!version) return;
    scenes.value = structuredClone(version.scenes);
    rev.value += 1;
    log("恢复版本", `${version.name}，排期账 v${rev.value}`);
  }

  function saveDraft() {
    if (!draft.value) {
      draft.value = { baseVersion: rev.value, changes: [], savedAt: new Date().toISOString() };
    }
    draft.value.savedAt = new Date().toISOString();
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft.value));
    log("保存离线草稿", dayjs(draft.value.savedAt).format("MM-DD HH:mm") + `（基础 v${draft.value.baseVersion}，${draft.value.changes.length} 项改动）`);
  }

  function loadDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      draft.value = raw ? (JSON.parse(raw) as OfflineDraft) : null;
    } catch {
      draft.value = null;
    }
  }

  function exempt(id: string) {
    exemptions.value.push(id);
    log("豁免冲突", id);
  }

  function setOnline(value: boolean) {
    online.value = value;
    if (value) {
      log("恢复联网", draft.value ? `有 ${draft.value.changes.length} 项离线改动待回网` : "无待回网改动");
    } else {
      if (!draft.value || draft.value.baseVersion !== rev.value) {
        draft.value = { baseVersion: rev.value, changes: [], savedAt: new Date().toISOString() };
      }
      log("切换离线", "改动将按字段记入草稿，回网后合并");
    }
  }

  /** 演示：两人同时提交同一字段，先写入生效，后写入留两版裁决 */
  function simulateConcurrentSubmit() {
    const scene = scenes.value.find((item) => item.status === "草稿") ?? scenes.value[0];
    if (!scene) return;
    const field = "day";
    const base = scene.fieldRev[field] ?? 0;
    const dayA = dayjs(scene.day).add(1, "day").format("YYYY-MM-DD");
    const dayB = dayjs(scene.day).add(2, "day").format("YYYY-MM-DD");
    const c1: FieldChange = {
      id: crypto.randomUUID(), sceneId: scene.id, field, oldValue: clone(scene.day), newValue: dayA,
      baseVersion: base, by: "场记", at: new Date().toISOString(), source: "离线", status: "待落地"
    };
    const c2: FieldChange = {
      id: crypto.randomUUID(), sceneId: scene.id, field, oldValue: clone(scene.day), newValue: dayB,
      baseVersion: base, by: "导演", at: new Date().toISOString(), source: "离线", status: "待落地"
    };
    landChange(c1);
    landChange(c2);
    log("并发提交演示", `${scene.code} 改拍摄日：场记 → ${dayA}，导演 → ${dayB}；先写入生效，后写入留两版裁决`);
  }

  function pendingChanges(sceneId: string): FieldChange[] {
    return draft.value?.changes.filter((item) => item.sceneId === sceneId && item.status === "待落地") ?? [];
  }

  return {
    rev, scenes, sortedScenes, conflicts, history, versions, role, online, draft, exemptions,
    changes, adjudications, pendingAdjudications, waitlist, activeWaitlist, occupancy, capacityReceipts, landedChanges,
    talents, locations, equipment,
    talentNames, equipmentNames, locationName, fieldLabel, describe,
    commitField, stageField, syncDraft, adjudicate, reschedule, cancelWaitlist, receiveCapacityReceipt,
    invalidateAndRecompute, addScene, updateStatus, toggleLock, moveScene, snapshot, restore,
    saveDraft, loadDraft, exempt, setOnline, simulateConcurrentSubmit, pendingChanges, landChange
  };
});
