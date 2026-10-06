<script setup lang="ts">
import dayjs from "dayjs";
import { useScheduleStore } from "../stores/schedule";
const store = useScheduleStore();
</script>
<template>
  <section class="page grid-2">
    <section class="panel">
      <div class="panel-head"><div><h2>版本快照</h2><small class="muted">恢复会覆盖当前通告，但保留恢复记录</small></div><button class="primary" :disabled="store.role === '场记'" @click="store.snapshot()">创建版本</button></div>
      <el-empty v-if="!store.versions.length" description="尚未创建版本" />
      <article v-for="item in store.versions" :key="item.id" class="draft-banner" style="margin-bottom:10px">
        <div><b>{{ item.name }}</b><br><small>{{ dayjs(item.time).format("YYYY-MM-DD HH:mm:ss") }} · {{ item.scenes.length }} 场 · 排期账 v{{ item.rev }}</small></div>
        <button class="secondary" :disabled="store.role !== '制片'" @click="store.restore(item.id)">恢复</button>
      </article>
    </section>
    <section class="panel">
      <div class="panel-head"><div><h2>排期账变更</h2><small class="muted">字段级记账：基础版本、字段、岗位与落地状态；重复回传不新增记录</small></div><span class="status">当前 v{{ store.rev }}</span></div>
      <el-empty v-if="!store.changes.length" description="暂无字段级变更" />
      <div v-for="item in store.changes" :key="item.id" class="ledger-row">
        <span class="ledger-status" :class="item.status">{{ item.status }}</span>
        <div class="ledger-main">
          <b>{{ item.sceneId.slice(0, 6) }} · {{ store.fieldLabel(item.field) }}</b>
          <small>{{ store.describe(item.field, item.oldValue) }} → {{ store.describe(item.field, item.newValue) }}</small>
        </div>
        <div class="ledger-meta">
          <small>{{ item.by }} · {{ item.source }}</small>
          <small>基础 v{{ item.baseVersion }}<template v-if="item.landedRev"> → v{{ item.landedRev }}</template></small>
          <small>{{ dayjs(item.at).format("MM-DD HH:mm:ss") }}</small>
        </div>
      </div>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>操作历史</h2></div>
      <div class="history">
        <el-empty v-if="!store.history.length" description="暂无操作" />
        <div v-for="item in store.history" :key="item.id" class="history-row"><span class="muted">{{ dayjs(item.time).format("MM-DD HH:mm:ss") }}</span><b>{{ item.action }}</b><span>{{ item.detail }}</span></div>
      </div>
    </section>
  </section>
</template>
