<script setup lang="ts">
import { useScheduleStore } from "../stores/schedule";
import type { Conflict } from "../types";

const store = useScheduleStore();
function sceneName(id: string) {
  const scene = store.scenes.find((item) => item.id === id);
  return scene ? `${scene.code} ${scene.title}` : id;
}
function exempt(item: Conflict) {
  store.exempt(item.key, item.fps);
}
</script>
<template>
  <section class="page">
    <section class="panel">
      <div class="panel-head"><div><h2>资源冲突中心</h2><small class="muted">按日期和时段检查演员、场地、器材与转场间隔；豁免绑定资源指纹，资源或时段一变立即失效重算</small></div><span class="status">{{ store.conflicts.length }} 项待处理</span></div>
      <article v-for="item in store.conflicts" :key="item.id" class="conflict">
        <span class="seal">{{ item.severity }}</span>
        <div><b>{{ item.type }}</b><p>{{ item.message }}</p><small>{{ item.sceneIds.map(sceneName).join(" ↔ ") }}</small></div>
        <button class="secondary" :disabled="store.role === '场记'" @click="exempt(item)">负责人豁免</button>
      </article>
      <el-empty v-if="!store.conflicts.length" description="当前没有未处理冲突" />
    </section>
    <section class="panel" v-if="store.exemptions.length">
      <div class="panel-head"><div><h2>生效中的豁免</h2><small class="muted">任一场次的拍摄日、时段、场地、演员、器材或状态变化，对应豁免自动失效</small></div></div>
      <div v-for="item in store.exemptions" :key="item.key" class="history-row">
        <span class="muted">{{ item.key }}</span><b>{{ item.by }} 豁免</b><span>指纹锚定 {{ item.fps.length }} 个场次版本</span>
      </div>
    </section>
  </section>
</template>
