export type Role = "制片" | "导演" | "演员统筹" | "场记";
export type SceneStatus = "草稿" | "已确认" | "拍摄中" | "已完成";
export type ConflictType = "演员档期" | "场地占用" | "器材借用" | "转场时间";

/** 参与字段级排期账的场次字段 */
export type SceneField =
  | "code"
  | "title"
  | "day"
  | "start"
  | "end"
  | "locationId"
  | "talentIds"
  | "equipmentIds"
  | "status";

/** 写入来源：在线直写 / 离线草稿回网 / 改期级联 / 裁决 / 候补转正 */
export type OpSource = "在线" | "离线草稿" | "改期" | "顺延" | "裁决" | "候补转正" | "系统";
export type OpResult = "applied" | "conflict" | "duplicate" | "failed";

export interface Talent {
  id: string;
  name: string;
  role: string;
}

export interface Location {
  id: string;
  name: string;
  /** 同时段可容纳的已确认/拍摄中场次上限 */
  capacity: number;
}

export interface Equipment {
  id: string;
  name: string;
}

/** 字段级版本元信息：每个字段独立记版本、岗位与落地操作 */
export interface FieldMeta {
  rev: number;
  role: Role;
  opId: string;
  at: string;
}

export interface Scene {
  id: string;
  code: string;
  title: string;
  day: string;
  start: string;
  end: string;
  talentIds: string[];
  locationId: string;
  equipmentIds: string[];
  status: SceneStatus;
  locked: boolean;
  meta: Record<SceneField, FieldMeta>;
}

/** 字段级写操作：带基础版本，重复回传按 opId 去重 */
export interface FieldOp {
  opId: string;
  sceneId: string;
  field: SceneField;
  value: unknown;
  /** 编辑发生时所基于的字段版本（时段字段会带上整组版本） */
  baseRevs: Partial<Record<SceneField, number>>;
  role: Role;
  source: OpSource;
  at: string;
}

export interface Receipt {
  op: FieldOp;
  result: OpResult;
  detail: string;
}

/** 排期账条目：只记录真实落地的字段写入 */
export interface LedgerEntry {
  id: string;
  opId: string;
  sceneId: string;
  sceneCode: string;
  field: SceneField;
  baseRev: number;
  newRev: number;
  role: Role;
  source: OpSource;
  summary: string;
  at: string;
}

/** 两边都改同一字段/时段：留两版等制片裁决 */
export interface FieldDispute {
  id: string;
  sceneId: string;
  sceneCode: string;
  field: SceneField;
  official: { value: unknown; rev: number; role: Role; at: string };
  incoming: FieldOp;
  at: string;
}

/** 场地容量排满后的候补排队，blocker 写明卡点 */
export interface WaitlistEntry {
  id: string;
  sceneId: string;
  sceneCode: string;
  locationId: string;
  start: string;
  end: string;
  candidateDays: string[];
  blocker: string;
  /** 计算该候补时所基于的排期纪元，纪元变了就要重算 */
  epoch: number;
  status: "候补中" | "已转正" | "已取消";
  queuedAt: string;
}

/** 豁免绑定资源/时段指纹，指纹一变立即失效 */
export interface Exemption {
  key: string;
  fps: string[];
  by: Role;
  at: string;
}

export interface Conflict {
  id: string;
  key: string;
  type: ConflictType;
  sceneIds: string[];
  message: string;
  severity: "高" | "中";
  fps: string[];
}

export interface HistoryEntry {
  id: string;
  action: string;
  detail: string;
  time: string;
}

export interface Version {
  id: string;
  name: string;
  time: string;
  scenes: Scene[];
}

/** 离线草稿：只存字段级改动与基础版本，不再整份覆盖 */
export interface OfflineDraft {
  baseEpoch: number;
  changes: FieldOp[];
  savedAt: string;
}

export interface OutboxItem {
  op: FieldOp;
  attempts: number;
  lastError: string;
}
