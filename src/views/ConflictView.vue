<script setup lang="ts">
import { reactive, ref } from "vue";
import { useScheduleStore } from "../stores/schedule";
const store = useScheduleStore();
const receiptForm = reactive({ locationId: "l1", day: "2026-10-08", capacity: 1 });
const receiptMsg = ref("");
function sceneName(id: string) {
  const scene = store.scenes.find((item) => item.id === id);
  return scene ? `${scene.code} ${scene.title}` : id;
}
function submitReceipt() {
  store.receiveCapacityReceipt(receiptForm.locationId, receiptForm.day, receiptForm.capacity);
  receiptMsg.value = `已接收 ${store.locationName(receiptForm.locationId)} ${receiptForm.day} 容量回执（${receiptForm.capacity}）`;
}
</script>
<template>
  <section class="page">
    <section class="panel">
      <div class="panel-head"><div><h2>资源冲突中心</h2><small class="muted">系统按日期和时间段检查演员、场地、器材与转场间隔；资源或时段一变，旧豁免立即失效重算</small></div><span class="status">{{ store.conflicts.length }} 项待处理</span></div>
      <article v-for="item in store.conflicts" :key="item.id" class="conflict">
        <span class="seal">{{ item.severity }}</span>
        <div><b>{{ item.type }}</b><p>{{ item.message }}</p><small>{{ item.sceneIds.map(sceneName).join(" ↔ ") }}</small></div>
        <button class="secondary" :disabled="store.role === '场记'" @click="store.exempt(item.id)">负责人豁免</button>
      </article>
      <el-empty v-if="!store.conflicts.length" description="当前没有未处理冲突" />
    </section>

    <section class="panel">
      <div class="panel-head"><div><h2>晚到容量回执</h2><small class="muted">回执不得顶掉已确认场次：已确认保留，未确认场次候补</small></div></div>
      <form class="form-grid" @submit.prevent="submitReceipt">
        <label class="field"><span>场地</span><select v-model="receiptForm.locationId"><option v-for="item in store.locations" :key="item.id" :value="item.id">{{ item.name }}（容量 {{ item.capacity }}）</option></select></label>
        <label class="field"><span>日期</span><input v-model="receiptForm.day" type="date" /></label>
        <label class="field"><span>回执可用容量</span><input v-model.number="receiptForm.capacity" type="number" min="1" /></label>
        <div class="actions wide"><button class="primary">接收容量回执</button></div>
      </form>
      <p v-if="receiptMsg" class="receipt-msg">{{ receiptMsg }}</p>
    </section>

    <section class="panel">
      <div class="panel-head"><div><h2>场地候补</h2><small class="muted">容量排满排队候补，写明卡点</small></div><span class="status">{{ store.activeWaitlist.length }} 项候补中</span></div>
      <article v-for="item in store.activeWaitlist" :key="item.id" class="waitlist-item">
        <div><b>{{ item.code }} {{ item.title }}</b><small>{{ item.day }} {{ item.start }}–{{ item.end }} · {{ item.resourceName }} · {{ item.resourceType }}</small></div>
        <p class="waitlist-reason">卡点：{{ item.reason }}</p>
        <button class="secondary" @click="store.cancelWaitlist(item.id)">取消候补</button>
      </article>
      <el-empty v-if="!store.activeWaitlist.length" description="当前没有候补场次" />
    </section>
  </section>
</template>
