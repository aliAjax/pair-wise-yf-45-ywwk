export type Role = "制片" | "导演" | "演员统筹" | "场记";
export type SceneStatus = "草稿" | "已确认" | "拍摄中" | "已完成";
export type ConflictType = "演员档期" | "场地占用" | "器材借用" | "转场时间";
export type ChangeStatus = "待落地" | "已落地" | "待裁决" | "已驳回" | "已失效";
export type ChangeSource = "在线" | "离线";
export type ResourceType = "场地" | "演员" | "器材";

export interface Talent {
  id: string;
  name: string;
  role: string;
}

export interface Location {
  id: string;
  name: string;
  /** 场地容量：同一时段最多容纳的场次 */
  capacity: number;
}

export interface Equipment {
  id: string;
  name: string;
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
  /** 每个字段最后一次落地时的排期账版本，用于字段级合并与先写入生效判定 */
  fieldRev: Record<string, number>;
  /** 资源/时段变动后，未确认排期标记重算 */
  needsRecompute?: boolean;
}

export interface Conflict {
  id: string;
  type: ConflictType;
  sceneIds: string[];
  message: string;
  severity: "高" | "中";
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
  /** 快照对应的排期账版本 */
  rev: number;
  scenes: Scene[];
}

/**
 * 字段级变更：排期账的最小记账单元。
 * 记录基础版本、字段和岗位，回网时按字段合并。
 */
export interface FieldChange {
  /** 幂等键：重复回传不新增记录 */
  id: string;
  sceneId: string;
  field: string;
  oldValue: unknown;
  newValue: unknown;
  /** 基础版本：该变更基于哪一版排期账 */
  baseVersion: number;
  /** 岗位 */
  by: Role;
  at: string;
  source: ChangeSource;
  status: ChangeStatus;
  /** 落地时的排期账版本 */
  landedRev?: number;
  /** 未落地原因（写入失败 / 待裁决） */
  reason?: string;
}

/** 两边改同一字段时留两版，等制片裁决 */
export interface Adjudication {
  id: string;
  sceneId: string;
  field: string;
  baseValue: unknown;
  localValue: unknown;
  remoteValue: unknown;
  localBy: Role;
  remoteBy: Role;
  createdAt: string;
  status: "待裁决" | "已裁决";
  decision?: "local" | "remote";
  decidedAt?: string;
}

/** 场地容量排满时候补，写明卡点 */
export interface WaitlistEntry {
  id: string;
  sceneId: string;
  code: string;
  title: string;
  resourceType: ResourceType;
  resourceId: string;
  resourceName: string;
  day: string;
  start: string;
  end: string;
  /** 卡点说明 */
  reason: string;
  status: "候补中" | "已排上" | "已取消";
  createdAt: string;
}

/** 占用记录：改期先释放旧占用 */
export interface Occupancy {
  id: string;
  sceneId: string;
  resourceType: ResourceType;
  resourceId: string;
  day: string;
  start: string;
  end: string;
  released: boolean;
}

/** 晚到的容量回执：不得顶掉已确认场次 */
export interface CapacityReceipt {
  id: string;
  locationId: string;
  day: string;
  /** 回执确认的可用容量 */
  capacity: number;
  receivedAt: string;
  applied: boolean;
}

export interface OfflineDraft {
  /** 草稿基于的排期账版本 */
  baseVersion: number;
  changes: FieldChange[];
  savedAt: string;
}
