<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import dayjs from "dayjs";
import { toTypedSchema } from "@vee-validate/zod";
import { useForm } from "vee-validate";
import { z } from "zod";
import { ElMessage } from "element-plus";
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

const editing = ref<Scene | null>(null);
const editForm = reactive({ day: "", start: "", end: "", locationId: "", talentIds: [] as string[], equipmentIds: [] as string[] });

const rescheduling = ref<Scene | null>(null);
const candidateText = ref("");

async function submit() {
  const result = await validate({ values: form } as never);
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

function advance(scene: Scene) {
  const next = scene.status === "草稿" ? "已确认" : scene.status === "已确认" ? "拍摄中" : scene.status === "拍摄中" ? "已完成" : "已完成";
  const error = store.updateStatus(scene.id, currentStatus(next));
  if (error) ElMessage.error(error);
}

function openEdit(scene: Scene) {
  editing.value = scene;
  Object.assign(editForm, {
    day: scene.day,
    start: scene.start,
    end: scene.end,
    locationId: scene.locationId,
    talentIds: [...scene.talentIds],
    equipmentIds: [...scene.equipmentIds]
  });
}

function saveEdit() {
  const scene = editing.value;
  if (!scene) return;
  const changes: Record<string, unknown> = {};
  if (editForm.day !== scene.day) changes.day = editForm.day;
  if (editForm.start !== scene.start) changes.start = editForm.start;
  if (editForm.end !== scene.end) changes.end = editForm.end;
  if (editForm.locationId !== scene.locationId) changes.locationId = editForm.locationId;
  if (JSON.stringify(editForm.talentIds) !== JSON.stringify(scene.talentIds)) changes.talentIds = [...editForm.talentIds];
  if (JSON.stringify(editForm.equipmentIds) !== JSON.stringify(scene.equipmentIds)) changes.equipmentIds = [...editForm.equipmentIds];
  if (!Object.keys(changes).length) {
    editing.value = null;
    return;
  }
  const receipts = store.editScene(scene.id, changes);
  editing.value = null;
  if (!store.online) {
    ElMessage.info(`离线中：${Object.keys(changes).length} 项字段改动已记入草稿，回网按字段合并`);
    return;
  }
  const conflicts = receipts.filter((item) => item.result === "conflict").length;
  const failed = receipts.filter((item) => item.result === "failed");
  if (failed.length) ElMessage.error(failed[0].detail);
  else if (conflicts) ElMessage.warning(`${conflicts} 项与正式侧撞单，已留两版待制片裁决`);
  else ElMessage.success("已按字段合入排期账");
}

function openReschedule(scene: Scene) {
  rescheduling.value = scene;
  candidateText.value = [1, 2].map((offset) => dayjs(scene.day).add(offset, "day").format("YYYY-MM-DD")).join(", ");
}

function doReschedule() {
  const scene = rescheduling.value;
  if (!scene) return;
  const days = candidateText.value.split(/[,，\s]+/).filter(Boolean);
  const logs = store.reschedule(scene.id, days);
  rescheduling.value = null;
  ElMessage[logs[0]?.startsWith("已改期") ? "success" : "warning"](logs[0] ?? "改期未生效");
}

function syncDraft() {
  const receipts = store.syncDraft();
  if (!receipts.length) return;
  const conflicts = receipts.filter((item) => item.result === "conflict").length;
  ElMessage[conflicts ? "warning" : "success"](conflicts ? `合并完成，${conflicts} 项撞单留两版待制片裁决` : "离线改动已按字段全部合入");
}
</script>

<template>
  <section class="page">
    <div class="metrics">
      <article class="metric"><span>通告场次</span><strong>{{ store.scenes.length }}</strong></article>
      <article class="metric"><span>待处理冲突</span><strong>{{ store.conflicts.length }}</strong></article>
      <article class="metric"><span>已确认</span><strong>{{ store.scenes.filter((item: Scene) => item.status === '已确认').length }}</strong></article>
      <article class="metric"><span>待裁决/未落地</span><strong>{{ store.pendingCount }}</strong></article>
    </div>
    <div v-if="store.draft && store.draft.changes.length" class="draft-banner">
      <span>
        离线草稿 {{ store.draft.changes.length }} 项字段改动（基础纪元 #{{ store.draft.baseEpoch }}，当前 #{{ store.epoch }}），
        回网后按字段合并，不会整份覆盖正式通告。
      </span>
      <div class="actions">
        <button class="primary" :disabled="!store.online" @click="syncDraft">回网按字段合并</button>
        <button class="secondary" @click="store.discardDraft">丢弃草稿</button>
      </div>
    </div>
    <div v-if="!store.online" class="offline-banner">离线中：字段改动将记入离线草稿并保留基础版本，回网后按字段合并。</div>
    <div class="grid-2">
      <section class="panel">
        <div class="panel-head"><div><h2>新增场次</h2><small class="muted">新场次为草稿，不占用场地容量</small></div></div>
        <form class="form-grid" @submit.prevent="submit">
          <label class="field"><span>场次编号</span><input v-model="form.code" placeholder="C-018" /><small>{{ errors.code }}</small></label>
          <label class="field"><span>场次名称</span><input v-model="form.title" placeholder="例如：雨夜追踪" /><small>{{ errors.title }}</small></label>
          <label class="field"><span>拍摄日</span><input v-model="form.day" type="date" /></label>
          <label class="field"><span>场地</span><select v-model="form.locationId"><option v-for="item in store.locations" :key="item.id" :value="item.id">{{ item.name }}（容量 {{ item.capacity }}）</option></select></label>
          <label class="field"><span>开始</span><input v-model="form.start" type="time" /></label>
          <label class="field"><span>结束</span><input v-model="form.end" type="time" /></label>
          <label class="field wide"><span>演员档期</span><select v-model="form.talentIds" multiple><option v-for="item in store.talents" :key="item.id" :value="item.id">{{ item.name }} · {{ item.role }}</option></select></label>
          <label class="field wide"><span>器材借用</span><select v-model="form.equipmentIds" multiple><option v-for="item in store.equipment" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
          <div class="actions wide"><button class="primary" :disabled="saving || !editable">保存为草稿</button><RouterLink class="secondary" to="/conflicts">检查冲突</RouterLink></div>
        </form>
      </section>
      <section class="panel">
        <div class="panel-head"><div><h2>当日通告顺序</h2><small class="muted">编辑与改期都走字段级排期账，版本快照后可随时恢复</small></div><button class="primary" :disabled="!editable" @click="store.snapshot()">保存版本</button></div>
        <div class="scene-list">
          <article v-for="(scene,index) in store.sortedScenes" :key="scene.id" class="scene" :class="{ locked: scene.locked, dragging: dragging === index }" draggable="true" @dragstart="dragging=index" @dragover.prevent @drop="drop(index)">
            <b>{{ index + 1 }}</b>
            <div class="scene-code">{{ scene.code }}</div>
            <div class="scene-title"><b>{{ scene.title }}</b><small>{{ scene.day }} {{ scene.start }}–{{ scene.end }} · {{ store.locations.find((item) => item.id === scene.locationId)?.name }}</small></div>
            <span class="status" :class="scene.status">{{ scene.status }}</span>
            <div class="actions">
              <button class="secondary" :disabled="!editable || scene.locked" @click="advance(scene)">推进</button>
              <button class="secondary" :disabled="scene.locked || scene.status === '拍摄中' || scene.status === '已完成'" @click="openEdit(scene)">编辑</button>
              <button class="secondary" :disabled="!editable || scene.locked || scene.status === '拍摄中' || scene.status === '已完成'" @click="openReschedule(scene)">改期</button>
              <button class="secondary" :disabled="!editable" @click="store.toggleLock(scene.id)">{{ scene.locked ? "解锁" : "锁定" }}</button>
            </div>
            <div class="scene-meta wide">
              <small>演员：{{ scene.talentIds.map((id) => store.talents.find((item) => item.id === id)?.name ?? id).join("、") || "待定" }} · 器材：{{ scene.equipmentIds.map((id) => store.equipment.find((item) => item.id === id)?.name ?? id).join("、") || "无" }}</small>
            </div>
          </article>
        </div>
      </section>
    </div>

    <el-dialog :model-value="!!editing" title="编辑场次（按字段落账）" width="520px" @close="editing = null">
      <div class="form-grid">
        <label class="field"><span>拍摄日</span><input v-model="editForm.day" type="date" /></label>
        <label class="field"><span>场地</span><select v-model="editForm.locationId"><option v-for="item in store.locations" :key="item.id" :value="item.id">{{ item.name }}（容量 {{ item.capacity }}）</option></select></label>
        <label class="field"><span>开始</span><input v-model="editForm.start" type="time" /></label>
        <label class="field"><span>结束</span><input v-model="editForm.end" type="time" /></label>
        <label class="field wide"><span>演员档期</span><select v-model="editForm.talentIds" multiple><option v-for="item in store.talents" :key="item.id" :value="item.id">{{ item.name }} · {{ item.role }}</option></select></label>
        <label class="field wide"><span>器材借用</span><select v-model="editForm.equipmentIds" multiple><option v-for="item in store.equipment" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
      </div>
      <template #footer>
        <div class="actions">
          <button class="secondary" @click="editing = null">取消</button>
          <button class="primary" @click="saveEdit">{{ store.online ? "合入排期账" : "记入离线草稿" }}</button>
        </div>
      </template>
    </el-dialog>

    <el-dialog :model-value="!!rescheduling" title="改期（先释放旧占用，再按候选日落位）" width="520px" @close="rescheduling = null">
      <p class="muted">共用资源的未确认场次会跟随顺延；容量排满则排队候补并写明卡点。已开拍场次保留原占用。</p>
      <label class="field"><span>候选日期（逗号分隔，按顺序尝试）</span><input v-model="candidateText" placeholder="2026-10-10, 2026-10-11" /></label>
      <template #footer>
        <div class="actions">
          <button class="secondary" @click="rescheduling = null">取消</button>
          <button class="primary" @click="doReschedule">执行改期</button>
        </div>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.offline-banner { padding: 12px 14px; border-radius: 10px; background: #eaf1ff; border: 1px solid #b9cdf5; color: #2c4a8a; }
</style>
