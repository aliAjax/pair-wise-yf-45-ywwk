import type { Equipment, FieldMeta, Location, Scene, SceneField, Talent } from "./types";

export const talents: Talent[] = [
  { id: "t1", name: "林川", role: "男主" },
  { id: "t2", name: "周禾", role: "女主" },
  { id: "t3", name: "顾言", role: "配角" },
  { id: "t4", name: "孙宁", role: "群演领队" }
];

export const locations: Location[] = [
  { id: "l1", name: "老码头", capacity: 1 },
  { id: "l2", name: "玻璃厂房", capacity: 2 },
  { id: "l3", name: "南站候车厅", capacity: 1 }
];

export const equipment: Equipment[] = [
  { id: "e1", name: "ARRI A机" },
  { id: "e2", name: "移动伸缩炮" },
  { id: "e3", name: "LED灯组" },
  { id: "e4", name: "跟拍车" }
];

const SEED_AT = "2026-10-06T09:00:00.000Z";

/** 为场次补齐字段级版本元信息（种子数据与新增场次共用） */
export function withMeta(scene: Omit<Scene, "meta">, role: FieldMeta["role"] = "制片"): Scene {
  const meta = {} as Record<SceneField, FieldMeta>;
  const fields: SceneField[] = ["code", "title", "day", "start", "end", "locationId", "talentIds", "equipmentIds", "status"];
  for (const field of fields) {
    meta[field] = { rev: 1, role, opId: "seed", at: SEED_AT };
  }
  return { ...scene, meta };
}

export const seedScenes: Scene[] = [
  withMeta({ id: "s1", code: "A-012", title: "码头交接", day: "2026-10-08", start: "08:00", end: "11:30", talentIds: ["t1", "t3"], locationId: "l1", equipmentIds: ["e1", "e3"], status: "已确认", locked: false }),
  withMeta({ id: "s2", code: "A-013", title: "厂房追逐", day: "2026-10-08", start: "10:30", end: "13:00", talentIds: ["t1", "t2"], locationId: "l1", equipmentIds: ["e2", "e4"], status: "草稿", locked: false }),
  withMeta({ id: "s3", code: "B-021", title: "候车厅告别", day: "2026-10-09", start: "15:00", end: "18:30", talentIds: ["t2", "t3"], locationId: "l3", equipmentIds: ["e1"], status: "草稿", locked: false })
];

export function locationName(id: string): string {
  return locations.find((item) => item.id === id)?.name ?? id;
}

export function locationCapacity(id: string): number {
  return locations.find((item) => item.id === id)?.capacity ?? 1;
}

export function talentNames(ids: string[]): string[] {
  return ids.map((id) => talents.find((item) => item.id === id)?.name ?? id);
}

export function equipmentNames(ids: string[]): string[] {
  return ids.map((id) => equipment.find((item) => item.id === id)?.name ?? id);
}
