<template>
  <section class="page" data-module="flotation">
    <header class="page-head">
      <div>
        <h2>浮选采样管理</h2>
        <p class="page-desc">维护浮选样本，围绕样本编号、采样单位、采样层位、土样重量做登记、筛选与状态流转。</p>
        <p class="boundary-hint">
          职责边界：现场组登记提交样本，检测室执行浮选、分拣、送检；跨单位人员访问样本只读。
          当前身份：{{ store.unit }}·{{ store.operator }}
        </p>
      </div>
      <div class="page-actions">
        <button
          class="btn primary"
          type="button"
          :disabled="!isFieldUnit"
          title="浮选样本由现场人员提交"
          @click="openCreate"
        >
          登记浮选样本
        </button>
        <button class="btn" type="button" @click="exportRows">导出浮选采样清单</button>
      </div>
    </header>

    <form v-if="creating" class="create-panel" @submit.prevent="submitCreate">
      <label v-for="field in createFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input
          v-model="draft[field]"
          :type="field === '现场复核日期' ? 'date' : 'text'"
          :placeholder="`填写${field}`"
        />
      </label>
      <button class="btn primary" type="submit">提交样本</button>
      <button class="btn ghost" type="button" @click="cancelCreate">取消</button>
    </form>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '操作记录'">
              <span v-for="entry in splitLog(row[column])" :key="entry" class="log-entry">
                {{ entry }}
              </span>
              <span v-if="!splitLog(row[column]).length">—</span>
            </template>
            <template v-else>{{ row[column] || '—' }}</template>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <template v-if="isLabUnit">
              <button
                v-for="action in actions"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </template>
            <span v-else class="readonly-tag">跨单位只读</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无浮选采样数据，可先登记浮选样本</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条浮选采样记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  createEntry,
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('flotation')
const columns = ["样本编号", "采样单位", "采样层位", "土样重量", "浮选日期", "轻浮物类型", "操作人", "样本状态", "归属单位", "现场复核日期", "操作记录"]
const actions = ["执行浮选", "完成分拣", "送出检测"]
const statuses = ["已采集", "已浮选", "已分拣", "已送检", "已返回"]
const stats = [{"label": "样本总数", "value": 0}, {"label": "已浮选数", "value": 0}, {"label": "待分拣数", "value": 0}]
const createFields = ["采样单位", "采样层位", "土样重量", "轻浮物类型", "现场复核日期"]

const store = useSessionStore()
const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const creating = ref(false)
const draft = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const isFieldUnit = computed(() => store.unit === '现场组')
const isLabUnit = computed(() => store.unit === '检测室')
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function splitLog(value: unknown): string[] {
  return String(value ?? '')
    .split('；')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = ''
  draft.value = { '现场复核日期': new Date().toISOString().slice(0, 10) }
  creating.value = true
}

function cancelCreate() {
  creating.value = false
  draft.value = {}
}

function submitCreate() {
  errorMessage.value = ''
  const result = createEntry(meta.key, draft.value, {
    operator: store.operator,
    unit: store.unit,
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  cancelCreate()
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action, {
    operator: store.operator,
    unit: store.unit,
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '浮选采样列表读取失败'
  }
}

onMounted(reload)
</script>
