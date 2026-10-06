<script setup lang="ts">
import { computed } from "vue";
import dayjs from "dayjs";
import { ElMessage } from "element-plus";
import { useScheduleStore } from "../stores/schedule";
import { FIELD_LABELS, formatFieldValue } from "../ledger/engine";
import type { FieldDispute } from "../types";

const store = useScheduleStore();
const canRule = computed(() => store.role === "制片");
const activeWaitlist = computed(() => store.waitlist.filter((item) => item.status === "候补中"));

function fmt(at: string) {
  return dayjs(at).format("MM-DD HH:mm:ss");
}

function disputeValue(dispute: FieldDispute, side: "official" | "incoming") {
  const value = side === "official" ? dispute.official.value : dispute.incoming.value;
  return formatFieldValue(dispute.field, value);
}

function flush() {
  const receipts = store.flushOutbox();
  if (!receipts.length) {
    ElMessage.info("没有待落地项（离线或队列已空）");
    return;
  }
  const conflicts = receipts.filter((item) => item.result === "conflict").length;
  const failed = receipts.filter((item) => item.result === "failed").length;
  ElMessage.success(`落地完成：合入 ${receipts.filter((item) => item.result === "applied").length} 项` + (conflicts ? `，${conflicts} 项留两版待裁决` : "") + (failed ? `，${failed} 项被拒` : ""));
}

function retry() {
  const receipts = store.retryOutbox();
  ElMessage[receipts.some((item) => item.result === "failed") ? "warning" : "success"](`重试完成：${receipts.length} 项处理，剩余 ${store.outbox.length} 项未落地`);
}

function resubmit() {
  const receipts = store.resubmitLastReceipts();
  ElMessage.info(`重复回传 ${receipts.length} 条，全部识别为已落地，账本未新增记录`);
}

function rival(opId: string) {
  store.simulateRival(opId);
  ElMessage.warning("他人已抢先写入同字段，你的提交回网后将留两版待制片裁决");
}

function rule(dispute: FieldDispute, side: "official" | "incoming") {
  store.resolveDispute(dispute.id, side);
  ElMessage.success(side === "incoming" ? "已采用离线版并落账" : "已维持正式版");
}
</script>

<template>
  <section class="page">
    <div class="metrics">
      <article class="metric"><span>排期账条目</span><strong>{{ store.ledger.length }}</strong></article>
      <article class="metric"><span>待裁决（两版并存）</span><strong>{{ store.disputes.length }}</strong></article>
      <article class="metric"><span>候补中</span><strong>{{ activeWaitlist.length }}</strong></article>
      <article class="metric"><span>未落地</span><strong>{{ store.outbox.length }}</strong></article>
    </div>

    <section class="panel" v-if="store.disputes.length">
      <div class="panel-head">
        <div><h2>撞单裁决</h2><small class="muted">两边都改了同一字段/时段，两版并存，等制片裁决</small></div>
        <span class="status 拍摄中">{{ store.disputes.length }} 项待裁决</span>
      </div>
      <article v-for="item in store.disputes" :key="item.id" class="dispute">
        <div class="dispute-head">
          <b>{{ item.sceneCode }}</b>
          <span class="tag">{{ FIELD_LABELS[item.field] }}</span>
          <small class="muted">{{ fmt(item.at) }} 撞单</small>
        </div>
        <div class="dispute-sides">
          <div class="side">
            <small>正式版 · v{{ item.official.rev }} · {{ item.official.role }}</small>
            <b>{{ disputeValue(item, "official") }}</b>
          </div>
          <div class="side alt">
            <small>离线版 · 基于 v{{ item.incoming.baseRevs[item.field] ?? 1 }} · {{ item.incoming.role }}</small>
            <b>{{ disputeValue(item, "incoming") }}</b>
          </div>
        </div>
        <div class="actions">
          <button class="secondary" :disabled="!canRule" @click="rule(item, 'official')">采用正式版</button>
          <button class="primary" :disabled="!canRule" @click="rule(item, 'incoming')">采用离线版</button>
          <small v-if="!canRule" class="muted">仅制片可裁决</small>
        </div>
      </article>
    </section>

    <section class="panel">
      <div class="panel-head">
        <div><h2>待写入口</h2><small class="muted">按到达顺序落地，先写入的生效；失败只重试未落地项，重复回传不新增记录</small></div>
        <div class="actions">
          <button class="primary" :disabled="!store.outbox.length || !store.online" @click="flush">立即写入（{{ store.outbox.length }}）</button>
          <button class="secondary" :disabled="!store.outbox.length" @click="store.injectFailure">注入写入失败</button>
          <button class="secondary" :disabled="!store.outbox.length" @click="retry">重试未落地项</button>
          <button class="secondary" :disabled="!store.lastReceipts.length" @click="resubmit">重复回传上批回执</button>
        </div>
      </div>
      <el-empty v-if="!store.outbox.length" description="队列已清空，全部落地" />
      <article v-for="item in store.outbox" :key="item.op.opId" class="outbox-row">
        <span class="tag">{{ item.op.source }}</span>
        <div>
          <b>{{ item.op.sceneId }}</b> · {{ FIELD_LABELS[item.op.field] }} → {{ formatFieldValue(item.op.field, item.op.value) }}
          <small class="muted">基础版本 v{{ item.op.baseRevs[item.op.field] ?? 1 }} · {{ item.op.role }} · 重试 {{ item.attempts }} 次</small>
          <small v-if="item.lastError" class="error">{{ item.lastError }}</small>
        </div>
        <button class="secondary" @click="rival(item.op.opId)">模拟他人抢先写同字段</button>
      </article>
    </section>

    <section class="panel">
      <div class="panel-head">
        <div><h2>场地候补</h2><small class="muted">容量排满就排队，写明卡点；占用一空出即按候选日转正，已开拍场次保留原占用</small></div>
      </div>
      <el-empty v-if="!store.waitlist.length" description="没有候补场次" />
      <article v-for="item in store.waitlist" :key="item.id" class="waitlist-row">
        <span class="status" :class="{ 已确认: item.status === '已转正' }">{{ item.status }}</span>
        <div>
          <b>{{ item.sceneCode }}</b> · {{ item.start }}–{{ item.end }} · 候选日 {{ item.candidateDays.join(" / ") }}
          <small class="muted">卡点：{{ item.blocker }}</small>
        </div>
        <button v-if="item.status === '候补中'" class="secondary" @click="store.cancelWaitlist(item.id)">退出候补</button>
      </article>
    </section>

    <section class="panel">
      <div class="panel-head">
        <div><h2>字段级排期账</h2><small class="muted">每条记录含基础版本、字段与岗位；容量由账本占用推导，晚到回执顶不掉已确认场次</small></div>
        <span class="status">纪元 #{{ store.epoch }}</span>
      </div>
      <el-empty v-if="!store.ledger.length" description="暂无落账记录" />
      <div v-for="item in store.ledger" :key="item.id" class="ledger-row">
        <span class="muted">{{ fmt(item.at) }}</span>
        <b>{{ item.sceneCode }}</b>
        <span>{{ item.summary }}</span>
        <span class="tag">v{{ item.baseRev }}→v{{ item.newRev }}</span>
        <span class="tag">{{ item.role }}</span>
        <span class="tag">{{ item.source }}</span>
      </div>
    </section>
  </section>
</template>

<style scoped>
.dispute { border: 1px solid #f2c1b5; background: #fff8f5; border-radius: 12px; padding: 14px; margin-bottom: 10px; display: grid; gap: 10px; }
.dispute-head { display: flex; gap: 10px; align-items: center; }
.dispute-sides { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.side { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; background: #fff; display: grid; gap: 4px; }
.side.alt { border-color: #efcf83; background: #fffaf0; }
.side small { color: var(--muted); }
.tag { display: inline-block; padding: 2px 8px; border-radius: 99px; background: #e8edf4; font-size: 12px; }
.outbox-row { display: grid; grid-template-columns: auto 1fr auto; gap: 12px; align-items: center; padding: 11px 0; border-bottom: 1px solid var(--line); }
.outbox-row small { display: block; }
.error { color: #c84545; }
.waitlist-row { display: grid; grid-template-columns: auto 1fr auto; gap: 12px; align-items: center; padding: 11px 0; border-bottom: 1px solid var(--line); }
.waitlist-row small { display: block; }
.ledger-row { display: grid; grid-template-columns: 130px 70px 1fr auto auto auto; gap: 10px; align-items: center; padding: 9px 0; border-bottom: 1px solid var(--line); font-size: 13px; }
@media (max-width: 680px) { .dispute-sides { grid-template-columns: 1fr; } .ledger-row { grid-template-columns: 1fr; } }
</style>
