import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
import dayjs from "dayjs";
import type {
  FieldOp,
  HistoryEntry,
  OfflineDraft,
  OutboxItem,
  Receipt,
  Role,
  Scene,
  SceneField,
  SceneStatus,
  Version
} from "../types";
import { equipment, locations, seedScenes, talents, withMeta } from "../data";
import {
  applyOp,
  detectConflicts,
  FIELD_LABELS,
  formatFieldValue,
  makeOp,
  rescheduleScene,
  runRecompute,
  type LedgerState
} from "../ledger/engine";

const STORAGE_KEY = "pair-wise-yf-45/schedule-v2";
const DRAFT_KEY = "pair-wise-yf-45/offline-draft-v2";

interface PersistedShape {
  state: LedgerState;
  history: HistoryEntry[];
  versions: Version[];
  outbox: OutboxItem[];
}

function freshState(): LedgerState {
  return {
    scenes: structuredClone(seedScenes),
    ledger: [],
    disputes: [],
    waitlist: [],
    exemptions: [],
    appliedOpIds: [],
    epoch: 1
  };
}

function readPersisted(): PersistedShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as PersistedShape;
  } catch {
    /* 数据损坏时回退种子 */
  }
  return { state: freshState(), history: [], versions: [], outbox: [] };
}

function readDraft(): OfflineDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as OfflineDraft) : null;
  } catch {
    return null;
  }
}

export const useScheduleStore = defineStore("schedule", () => {
  const persisted = readPersisted();
  const state = ref<LedgerState>(persisted.state);
  const history = ref<HistoryEntry[]>(persisted.history);
  const versions = ref<Version[]>(persisted.versions);
  const outbox = ref<OutboxItem[]>(persisted.outbox);
  const draft = ref<OfflineDraft | null>(readDraft());
  const role = ref<Role>("制片");
  const online = ref(navigator.onLine);
  const lastReceipts = ref<Receipt[]>([]);
  /** 注入故障：下一次 flush 在落地 N 条后模拟写入失败 */
  const failAfter = ref<number | null>(null);

  const scenes = computed(() => state.value.scenes);
  const ledger = computed(() => state.value.ledger);
  const disputes = computed(() => state.value.disputes);
  const waitlist = computed(() => state.value.waitlist);
  const exemptions = computed(() => state.value.exemptions);
  const epoch = computed(() => state.value.epoch);
  const conflicts = computed(() => detectConflicts(state.value));
  const sortedScenes = computed(() => [...state.value.scenes].sort((a, b) => `${a.day} ${a.start}`.localeCompare(`${b.day} ${b.start}`)));
  const pendingCount = computed(() => state.value.disputes.length + outbox.value.length);

  function log(action: string, detail: string) {
    history.value.unshift({ id: crypto.randomUUID(), action, detail, time: new Date().toISOString() });
    history.value = history.value.slice(0, 120);
  }

  function persist() {
    const shape: PersistedShape = { state: state.value, history: history.value, versions: versions.value, outbox: outbox.value };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(shape));
  }

  watch([state, history, versions, outbox], persist, { deep: true });

  watch(
    draft,
    (value) => {
      if (value && value.changes.length) localStorage.setItem(DRAFT_KEY, JSON.stringify(value));
      else localStorage.removeItem(DRAFT_KEY);
    },
    { deep: true }
  );

  /** 每次写路径结束后都要失效重算：旧豁免按指纹失效，候补按新占用重算 */
  function recompute() {
    const logs = runRecompute(state.value);
    for (const line of logs) log("失效重算", line);
  }

  function summarize(receipts: Receipt[]): string {
    const count = (result: Receipt["result"]) => receipts.filter((item) => item.result === result).length;
    return `合入 ${count("applied")} · 待裁决 ${count("conflict")} · 重复 ${count("duplicate")} · 失败 ${count("failed")}`;
  }

  /** 在线直写：先把待发队列排前面落地，保证先提交先生效 */
  function commitOp(op: FieldOp): Receipt {
    if (outbox.value.length) flushOutbox();
    const receipt = applyOp(state.value, op);
    if (receipt.result === "failed") log("写入被拒", `${sceneCodeOf(op.sceneId)} ${FIELD_LABELS[op.field]}：${receipt.detail}`);
    if (receipt.result === "conflict") log("撞单待裁决", `${receipt.op.sceneId} ${FIELD_LABELS[op.field]} 留两版`);
    recompute();
    return receipt;
  }

  function sceneCodeOf(sceneId: string): string {
    return state.value.scenes.find((item) => item.id === sceneId)?.code ?? sceneId;
  }

  /** 字段级编辑入口：在线直写落账，离线按字段记入草稿（同字段保留最早基础版本） */
  function editField(sceneId: string, field: SceneField, value: unknown): Receipt | null {
    const scene = state.value.scenes.find((item) => item.id === sceneId);
    if (!scene) return null;
    const op = makeOp(scene, field, value, role.value, online.value ? "在线" : "离线草稿");
    if (online.value) return commitOp(op);
    if (!draft.value) draft.value = { baseEpoch: state.value.epoch, changes: [], savedAt: new Date().toISOString() };
    const existing = draft.value.changes.find((item) => item.sceneId === sceneId && item.field === field);
    if (existing) {
      existing.value = structuredClone(value);
      existing.at = op.at;
    } else {
      draft.value.changes.push(op);
    }
    draft.value.savedAt = new Date().toISOString();
    log("离线记录", `${scene.code} ${FIELD_LABELS[field]} → ${formatFieldValue(field, value)}（基础版本 v${op.baseRevs[field] ?? 1}）`);
    return null;
  }

  function editScene(sceneId: string, changes: Partial<Record<SceneField, unknown>>): Receipt[] {
    const receipts: Receipt[] = [];
    for (const [field, value] of Object.entries(changes) as [SceneField, unknown][]) {
      const receipt = editField(sceneId, field, value);
      if (receipt) receipts.push(receipt);
    }
    return receipts;
  }

  /** 回网合并：草稿字段改动进入待发队列按字段合并，绝不整份覆盖 */
  function syncDraft(): Receipt[] {
    if (!draft.value || !draft.value.changes.length) return [];
    if (!online.value) {
      log("回网合并", "仍在离线，草稿保留待回网后合并");
      return [];
    }
    const count = draft.value.changes.length;
    for (const op of draft.value.changes) outbox.value.push({ op, attempts: 0, lastError: "" });
    draft.value = null;
    const receipts = flushOutbox();
    log("回网合并", `草稿 ${count} 项字段改动按字段合并：${summarize(receipts)}`);
    return receipts;
  }

  function discardDraft() {
    const count = draft.value?.changes.length ?? 0;
    draft.value = null;
    log("丢弃草稿", `放弃 ${count} 项离线字段改动`);
  }

  /**
   * 写队列落地：按到达顺序逐条写入，先写入的生效；
   * 模拟故障时只保留未落地项，重试只发未落地项；已落地回执重复回传不新增记录。
   */
  function flushOutbox(): Receipt[] {
    const receipts: Receipt[] = [];
    if (!online.value) {
      if (outbox.value.length) log("写入暂停", `离线中，${outbox.value.length} 项待落地`);
      return receipts;
    }
    let landed = 0;
    while (outbox.value.length) {
      if (failAfter.value !== null && landed >= failAfter.value) {
        failAfter.value = null;
        for (const item of outbox.value) {
          item.attempts += 1;
          item.lastError = "写入中断：网络抖动，未落地";
        }
        log("写入失败", `已落地 ${landed} 项，剩余 ${outbox.value.length} 项未落地，等待重试`);
        break;
      }
      const item = outbox.value[0];
      const receipt = applyOp(state.value, item.op);
      receipts.push(receipt);
      if (receipt.result === "failed") log("写入被拒", `${sceneCodeOf(item.op.sceneId)} ${FIELD_LABELS[item.op.field]}：${receipt.detail}`);
      if (receipt.result === "conflict") log("撞单待裁决", `${sceneCodeOf(item.op.sceneId)} ${FIELD_LABELS[item.op.field]} 留两版等制片裁决`);
      outbox.value.shift();
      landed += 1;
    }
    if (receipts.length) lastReceipts.value = receipts;
    recompute();
    return receipts;
  }

  /** 重试：只重发未落地项 */
  function retryOutbox(): Receipt[] {
    const receipts = flushOutbox();
    if (receipts.length) log("重试写入", `未落地项重试：${summarize(receipts)}`);
    return receipts;
  }

  /** 重复回传演示：上批回执原样重发，全部按 opId 去重，不新增记录 */
  function resubmitLastReceipts(): Receipt[] {
    const receipts = lastReceipts.value.map((receipt) => applyOp(state.value, receipt.op));
    const duplicates = receipts.filter((item) => item.result === "duplicate").length;
    log("重复回传", `重发 ${receipts.length} 条回执，${duplicates} 条识别为已落地，未新增记录`);
    return receipts;
  }

  /** 并发演示：他人以当前版本抢先写同字段，先写入生效，后到草稿留两版 */
  function simulateRival(opId: string): Receipt | null {
    const item = outbox.value.find((entry) => entry.op.opId === opId);
    if (!item) return null;
    const scene = state.value.scenes.find((entry) => entry.id === item.op.sceneId);
    if (!scene) return null;
    const rivalValue = rivalValueOf(item.op.field, item.op.value);
    const rival = makeOp(scene, item.op.field, rivalValue, role.value === "制片" ? "导演" : "制片", "在线");
    const receipt = applyOp(state.value, rival);
    log("并发写入", `${sceneCodeOf(scene.id)} ${FIELD_LABELS[item.op.field]} 被 ${rival.role} 抢先写入（v${rival.baseRevs[item.op.field] ?? 1} → 生效），你的提交将留两版待裁决`);
    recompute();
    return receipt;
  }

  function rivalValueOf(field: SceneField, value: unknown): unknown {
    if (field === "day") return dayjs(String(value)).add(1, "day").format("YYYY-MM-DD");
    if (field === "start" || field === "end") return dayjs(`2026-01-01 ${String(value)}`).add(30, "minute").format("HH:mm");
    if (field === "locationId") return locations.find((item) => item.id !== value)?.id ?? value;
    if (field === "talentIds") return [...talents.map((item) => item.id).filter((id) => !(value as string[]).includes(id)).slice(0, 1)];
    if (field === "equipmentIds") return [...equipment.map((item) => item.id).filter((id) => !(value as string[]).includes(id)).slice(0, 1)];
    if (field === "status") return "已确认";
    return `${String(value)}（他改）`;
  }

  /** 制片裁决：采用哪版，哪版落账升版 */
  function resolveDispute(disputeId: string, side: "official" | "incoming"): Receipt | null {
    const dispute = state.value.disputes.find((item) => item.id === disputeId);
    if (!dispute) return null;
    const scene = state.value.scenes.find((item) => item.id === dispute.sceneId);
    state.value.disputes = state.value.disputes.filter((item) => item.id !== disputeId);
    if (side === "official" || !scene) {
      log("裁决", `${dispute.sceneCode} ${FIELD_LABELS[dispute.field]} 维持正式版`);
      return null;
    }
    const ruling = makeOp(scene, dispute.field, dispute.incoming.value, role.value, "裁决");
    const receipt = applyOp(state.value, ruling);
    log("裁决", `${dispute.sceneCode} ${FIELD_LABELS[dispute.field]} 采用离线版，已落账`);
    recompute();
    return receipt;
  }

  /** 改期：释放旧占用 → 候选日落位 → 共用资源场次顺延 → 满员候补写卡点 */
  function reschedule(sceneId: string, candidateDays: string[]): string[] {
    const { logs, movedTo } = rescheduleScene(state.value, sceneId, candidateDays, role.value);
    for (const line of logs) log("改期", line);
    recompute();
    return movedTo ? [`已改期到 ${movedTo}`] : logs;
  }

  function cancelWaitlist(entryId: string) {
    const entry = state.value.waitlist.find((item) => item.id === entryId);
    if (!entry || entry.status !== "候补中") return;
    entry.status = "已取消";
    log("候补取消", `${entry.sceneCode} 退出排队`);
  }

  function exempt(conflictKey: string, fps: string[]) {
    state.value.exemptions.push({ key: conflictKey, fps: [...fps], by: role.value, at: new Date().toISOString() });
    log("豁免冲突", `${conflictKey}（资源或时段一变即失效）`);
  }

  function addScene(input: Omit<Scene, "id" | "status" | "locked" | "meta">) {
    const scene = withMeta({ ...input, id: crypto.randomUUID(), status: "草稿", locked: false }, role.value);
    state.value.scenes.push(scene);
    log("新增场次", `${input.code} ${input.title}`);
  }

  function updateStatus(id: string, status: SceneStatus): string | null {
    const scene = state.value.scenes.find((item) => item.id === id);
    if (!scene) return "场次不存在";
    if (scene.locked) return "场次已锁定";
    const receipt = commitOp(makeOp(scene, "status", status, role.value, "在线"));
    if (receipt.result === "failed") return receipt.detail;
    if (receipt.result === "conflict") return "状态字段撞单，已留两版待裁决";
    log("流转状态", `${scene.code} → ${status}`);
    return null;
  }

  function toggleLock(id: string) {
    const scene = state.value.scenes.find((item) => item.id === id);
    if (!scene) return;
    scene.locked = !scene.locked;
    log(scene.locked ? "锁定场次" : "解锁场次", scene.code);
  }

  function moveScene(from: number, to: number) {
    if (from === to || to < 0 || to >= state.value.scenes.length) return;
    const [item] = state.value.scenes.splice(from, 1);
    state.value.scenes.splice(to, 0, item);
    log("调整顺序", `${item.code} 移至第 ${to + 1} 位`);
  }

  function snapshot(name = `版本 ${versions.value.length + 1}`) {
    versions.value.unshift({ id: crypto.randomUUID(), name, time: new Date().toISOString(), scenes: structuredClone(state.value.scenes) });
    versions.value = versions.value.slice(0, 12);
    log("保存版本", name);
  }

  function restore(id: string) {
    const version = versions.value.find((item) => item.id === id);
    if (!version) return;
    state.value.scenes = structuredClone(version.scenes);
    state.value.epoch += 1;
    log("恢复版本", `${version.name}，未确认排期与旧豁免已失效重算`);
    recompute();
  }

  function setOnline(value: boolean) {
    online.value = value;
    if (value) {
      log("恢复在线", "待发队列将按到达顺序落地");
      if (draft.value?.changes.length) log("待合并", `离线草稿 ${draft.value.changes.length} 项字段改动等待回网合并`);
    } else {
      log("进入离线", "字段改动将记入离线草稿，保留基础版本");
    }
  }

  function injectFailure() {
    failAfter.value = 1;
    log("注入故障", "下一次写入将在落地 1 条后模拟失败");
  }

  return {
    scenes,
    sortedScenes,
    conflicts,
    history,
    versions,
    ledger,
    disputes,
    waitlist,
    exemptions,
    epoch,
    outbox,
    lastReceipts,
    pendingCount,
    role,
    online,
    draft,
    talents,
    locations,
    equipment,
    editField,
    editScene,
    syncDraft,
    discardDraft,
    flushOutbox,
    retryOutbox,
    resubmitLastReceipts,
    simulateRival,
    resolveDispute,
    reschedule,
    cancelWaitlist,
    exempt,
    addScene,
    updateStatus,
    toggleLock,
    moveScene,
    snapshot,
    restore,
    setOnline,
    injectFailure
  };
});
