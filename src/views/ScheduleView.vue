<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import dayjs from "dayjs";
import { toTypedSchema } from "@vee-validate/zod";
import { useForm } from "vee-validate";
import { z } from "zod";
import { useScheduleStore } from "../stores/schedule";
import type { Scene, SceneStatus } from "../types";

const store = useScheduleStore();
const saving = ref(false);
const dragging = ref<number | null>(null);
const form = reactive({ code: "", title: "", day: "2026-10-08", start: "08:00", end: "10:00", locationId: "l1", talentIds: [] as string[], equipmentIds: [] as string[] });
const schema = toTypedSchema(z.object({
  code: z.string().min(2, "请输入场次编号"),
  title: z.string().min(2, "请输入场次名称"),
  day: z.string().min(1),
  start: z.string().min(1),
  end: z.string().min(1),
  locationId: z.string().min(1)
}));
const { errors, validate } = useForm({ validationSchema: schema });
const editable = computed(() => store.role === "制片" || store.role === "导演");
const currentStatus = (status: string) => status as SceneStatus;

const editingId = ref<string | null>(null);
const editForm = reactive({ day: "", locationId: "l1", talentIds: [] as string[], equipmentIds: [] as string[] });

onMounted(() => store.loadDraft());

async function submit() {
  const result = await validate({ values: form } as any);
  if (!result.valid) return;
  saving.value = true;
  store.addScene({ code: form.code, title: form.title, day: form.day, start: form.start, end: form.end, locationId: form.locationId, talentIds: [...form.talentIds], equipmentIds: [...form.equipmentIds] });
  Object.assign(form, { code: "", title: "", day: "2026-10-08", start: "08:00", end: "10:00", locationId: "l1", talentIds: [], equipmentIds: [] });
  setTimeout(() => { saving.value = false; }, 240);
}

function drop(index: number) {
  if (dragging.value !== null && editable.value) store.moveScene(dragging.value, index);
  dragging.value = null;
}

function startEdit(scene: Scene) {
  editingId.value = scene.id;
  editForm.day = scene.day;
  editForm.locationId = scene.locationId;
  editForm.talentIds = [...scene.talentIds];
  editForm.equipmentIds = [...scene.equipmentIds];
}

function saveEdit(scene: Scene) {
  const fields: { field: string; value: unknown }[] = [
    { field: "day", value: editForm.day },
    { field: "locationId", value: editForm.locationId },
    { field: "talentIds", value: [...editForm.talentIds] },
    { field: "equipmentIds", value: [...editForm.equipmentIds] }
  ];
  for (const item of fields) {
    const changed = JSON.stringify(item.value) !== JSON.stringify((scene as unknown as Record<string, unknown>)[item.field]);
    if (!changed) continue;
    if (store.online) store.commitField(scene.id, item.field, item.value);
    else store.stageField(scene.id, item.field, item.value);
  }
  editingId.value = null;
}

function reschedule(scene: Scene) {
  const next = dayjs(scene.day).add(1, "day").format("YYYY-MM-DD");
  if (typeof window !== "undefined" && !window.confirm(`将 ${scene.code} 改期至 ${next}？\n将先释放旧占用，再按候选日期顺延共用资源的场次。`)) return;
  store.reschedule(scene.id, next);
}

function pendingLabel(sceneId: string, field: string) {
  const change = store.pendingChanges(sceneId).find((item) => item.field === field);
  return change ? store.describe(field, change.newValue) : null;
}
</script>

<template>
  <section class="page">
    <div class="metrics">
      <article class="metric"><span>通告场次</span><strong>{{ store.scenes.length }}</strong></article>
      <article class="metric"><span>待处理冲突</span><strong>{{ store.conflicts.length }}</strong></article>
      <article class="metric"><span>待裁决</span><strong>{{ store.pendingAdjudications.length }}</strong></article>
      <article class="metric"><span>候补中</span><strong>{{ store.activeWaitlist.length }}</strong></article>
    </div>

    <div v-if="store.draft" class="draft-banner">
      <div>
        <b>离线草稿（基础版本 v{{ store.draft.baseVersion }}）</b>
        <small> · {{ dayjs(store.draft.savedAt).format("MM-DD HH:mm") }} · {{ store.draft.changes.length }} 项字段改动待回网</small>
        <div v-for="item in store.draft.changes" :key="item.id" class="draft-change">
          <span class="field-tag">{{ store.fieldLabel(item.field) }}</span>
          <small>{{ item.sceneId.slice(0, 6) }} · {{ item.by }} · {{ store.describe(item.field, item.oldValue) }} → {{ store.describe(item.field, item.newValue) }}</small>
        </div>
      </div>
      <div class="actions"><button class="primary" @click="store.syncDraft">按字段回网合并</button></div>
    </div>

    <div v-if="store.pendingAdjudications.length" class="panel adjudication-panel">
      <div class="panel-head"><div><h2>字段冲突 · 两版待裁决</h2><small class="muted">两边都改了同一字段，留两版等制片裁决，先写入的生效</small></div></div>
      <article v-for="adj in store.pendingAdjudications" :key="adj.id" class="adjudication">
        <div class="adj-scene">{{ adj.sceneId.slice(0, 6) }} · <b>{{ store.fieldLabel(adj.field) }}</b></div>
        <div class="adj-versions">
          <div class="adj-version"><small>离线版（{{ adj.localBy }}）</small><b>{{ store.describe(adj.field, adj.localValue) }}</b></div>
          <div class="adj-vs">VS</div>
          <div class="adj-version"><small>正式版（{{ adj.remoteBy }}）</small><b>{{ store.describe(adj.field, adj.remoteValue) }}</b></div>
        </div>
        <div class="actions">
          <button class="secondary" :disabled="store.role !== '制片'" @click="store.adjudicate(adj.id, 'local')">采用离线版</button>
          <button class="primary" :disabled="store.role !== '制片'" @click="store.adjudicate(adj.id, 'remote')">采用正式版</button>
        </div>
      </article>
    </div>

    <div class="grid-2">
      <section class="panel">
        <div class="panel-head"><h2>新增场次</h2><button class="secondary" @click="store.saveDraft">保存离线草稿</button></div>
        <form class="form-grid" @submit.prevent="submit">
          <label class="field"><span>场次编号</span><input v-model="form.code" placeholder="C-018" /><small>{{ errors.code }}</small></label>
          <label class="field"><span>场次名称</span><input v-model="form.title" placeholder="例如：雨夜追踪" /><small>{{ errors.title }}</small></label>
          <label class="field"><span>拍摄日</span><input v-model="form.day" type="date" /></label>
          <label class="field"><span>场地</span><select v-model="form.locationId"><option v-for="item in store.locations" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
          <label class="field"><span>开始</span><input v-model="form.start" type="time" /></label>
          <label class="field"><span>结束</span><input v-model="form.end" type="time" /></label>
          <label class="field wide"><span>演员档期</span><select v-model="form.talentIds" multiple><option v-for="item in store.talents" :key="item.id" :value="item.id">{{ item.name }} · {{ item.role }}</option></select></label>
          <label class="field wide"><span>器材借用</span><select v-model="form.equipmentIds" multiple><option v-for="item in store.equipment" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
          <div class="actions wide"><button class="primary" :disabled="saving || !editable">保存为草稿</button><RouterLink class="secondary" to="/conflicts">检查冲突</RouterLink></div>
        </form>
        <div class="demo-box">
          <small>演示：两人同时提交同一字段</small>
          <button class="secondary" @click="store.simulateConcurrentSubmit">模拟并发提交</button>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><div><h2>当日通告顺序</h2><small class="muted">拖拽调整顺序，版本快照后可恢复</small></div><button class="primary" :disabled="!editable" @click="store.snapshot()">保存版本</button></div>
        <div class="scene-list">
          <article v-for="(scene, index) in store.sortedScenes" :key="scene.id" class="scene" :class="{ locked: scene.locked, dragging: dragging === index, recompute: scene.needsRecompute }" draggable="true" @dragstart="dragging = index" @dragover.prevent @drop="drop(index)">
            <b>{{ index + 1 }}</b>
            <div class="scene-code">{{ scene.code }}</div>
            <div class="scene-title">
              <b>{{ scene.title }}</b>
              <small>{{ pendingLabel(scene.id, 'day') ?? scene.day }} {{ scene.start }}–{{ scene.end }} · {{ store.locationName(scene.locationId) }}</small>
              <small v-if="store.pendingChanges(scene.id).length" class="pending-tags">
                <span v-for="c in store.pendingChanges(scene.id)" :key="c.id" class="pending-tag">{{ store.fieldLabel(c.field) }} → {{ store.describe(c.field, c.newValue) }}（待回网）</span>
              </small>
              <small v-if="scene.needsRecompute" class="recompute-tag">资源变动 · 待重算</small>
            </div>
            <span class="status" :class="scene.status">{{ scene.status }}</span>
            <div class="actions">
              <button class="secondary" :disabled="!editable || scene.locked" @click="store.updateStatus(scene.id, currentStatus(scene.status === '草稿' ? '已确认' : scene.status === '已确认' ? '拍摄中' : scene.status === '拍摄中' ? '已完成' : '已完成'))">推进</button>
              <button class="secondary" :disabled="!editable" @click="startEdit(scene)">编辑</button>
              <button class="secondary" :disabled="!editable || scene.locked || scene.status === '拍摄中' || scene.status === '已完成'" @click="reschedule(scene)">改期</button>
              <button class="secondary" :disabled="!editable" @click="store.toggleLock(scene.id)">{{ scene.locked ? "解锁" : "锁定" }}</button>
            </div>
            <div v-if="editingId === scene.id" class="scene-edit wide">
              <label class="field"><span>拍摄日</span><input v-model="editForm.day" type="date" /></label>
              <label class="field"><span>场地</span><select v-model="editForm.locationId"><option v-for="item in store.locations" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
              <label class="field wide"><span>演员</span><select v-model="editForm.talentIds" multiple><option v-for="item in store.talents" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
              <label class="field wide"><span>器材</span><select v-model="editForm.equipmentIds" multiple><option v-for="item in store.equipment" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
              <div class="actions wide"><button class="primary" @click="saveEdit(scene)">保存{{ store.online ? "（在线落地）" : "（记入草稿）" }}</button><button class="secondary" @click="editingId = null">取消</button></div>
            </div>
            <div class="scene-meta wide">
              <small>演员：{{ store.talentNames(scene.talentIds).join("、") || "待定" }} · 器材：{{ store.equipmentNames(scene.equipmentIds).join("、") || "无" }}</small>
              <small v-if="scene.status === '拍摄中' || scene.status === '已完成'" class="locked-tag">已开拍 · 保留原占用</small>
            </div>
          </article>
        </div>
      </section>
    </div>

    <div v-if="store.activeWaitlist.length" class="panel">
      <div class="panel-head"><div><h2>场地候补</h2><small class="muted">容量排满排队候补，写明卡点；已开拍场次保留原占用</small></div></div>
      <article v-for="item in store.activeWaitlist" :key="item.id" class="waitlist-item">
        <div><b>{{ item.code }} {{ item.title }}</b><small>{{ item.day }} {{ item.start }}–{{ item.end }} · {{ item.resourceName }}</small></div>
        <p class="waitlist-reason">卡点：{{ item.reason }}</p>
        <button class="secondary" @click="store.cancelWaitlist(item.id)">取消候补</button>
      </article>
    </div>
  </section>
</template>
