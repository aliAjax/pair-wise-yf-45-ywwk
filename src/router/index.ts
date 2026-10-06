import { createRouter, createWebHashHistory } from "vue-router";
import ScheduleView from "../views/ScheduleView.vue";
import LedgerView from "../views/LedgerView.vue";
import ConflictView from "../views/ConflictView.vue";
import HistoryView from "../views/HistoryView.vue";

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", name: "schedule", component: ScheduleView },
    { path: "/ledger", name: "ledger", component: LedgerView },
    { path: "/conflicts", name: "conflicts", component: ConflictView },
    { path: "/history", name: "history", component: HistoryView }
  ]
});
