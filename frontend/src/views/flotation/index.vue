<template>
  <section class="page" data-module="flotation">
    <header class="page-head">
      <div>
        <h2>浮选采样管理</h2>
        <p class="page-desc">浮选样本由现场组提交；浮选、分拣、送检由检测室执行。现场组跨单位访问样本只读，历史样本按原单位归属。</p>
      </div>
      <div class="page-actions">
        <button
          class="btn primary"
          type="button"
          :disabled="isLab"
          :title="isLab ? '检测室只负责浮选、分拣、送检，样本由现场组提交' : ''"
          @click="openCreate"
        >登记浮选样本</button>
        <button class="btn" type="button" @click="exportRows">导出浮选采样清单</button>
      </div>
    </header>

    <p class="boundary-banner" :class="isLab ? 'banner-lab' : 'banner-field'">
      当前身份：<strong>{{ roleLabel }} · {{ store.unit }}</strong>
      <template v-if="isLab">（可对各单位样本执行浮选、分拣、送检）</template>
      <template v-else>（只能提交与复核本单位「{{ store.unit }}」样本，其他单位只读）</template>
    </p>

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
          <th>操作记录</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '归属单位'">
              {{ row[column] ?? '—' }}
              <span v-if="isReadOnly(row)" class="readonly-tag">跨单位只读</span>
            </template>
            <template v-else-if="column === '分拣结果'">
              {{ row[column] || '—' }}
            </template>
            <template v-else>{{ row[column] || '—' }}</template>
          </td>
          <td class="log-cell" :title="String(row['操作记录'] ?? '')">{{ lastLog(row) }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <template v-if="rowActions(row).length">
              <button
                v-for="action in rowActions(row)"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </template>
            <span v-else class="muted-text">{{ isReadOnly(row) ? '只读' : '—' }}</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无浮选采样数据，可先登记浮选样本</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条浮选采样记录</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="dialogMode" class="modal-mask" @click.self="closeDialog">
      <div class="modal-card">
        <h3 class="modal-title">{{ dialogMode === 'create' ? '登记浮选样本' : '现场复核' }}</h3>

        <form v-if="dialogMode === 'create'" class="modal-form" @submit.prevent="confirmCreate">
          <label class="form-item">
            <span>样本编号</span>
            <input v-model="form.sampleCode" placeholder="例如 FLOT-0010" required />
          </label>
          <label class="form-item">
            <span>采样单位（归属单位）</span>
            <input :value="store.unit" disabled />
          </label>
          <label class="form-item">
            <span>采样层位</span>
            <input v-model="form.layer" placeholder="例如 T0304④层" required />
          </label>
          <label class="form-item">
            <span>土样重量</span>
            <input v-model="form.weight" placeholder="例如 20L" required />
          </label>
          <p class="form-hint">样本提交后状态为「已采集」，浮选、分拣与送检由检测室执行。</p>
          <div class="modal-actions">
            <button class="btn primary" type="submit">提交样本</button>
            <button class="btn ghost" type="button" @click="closeDialog">取消</button>
          </div>
        </form>

        <form v-else class="modal-form" @submit.prevent="confirmReview">
          <p class="form-hint">
            复核样本：{{ dialogRow?.['样本编号'] }}（{{ dialogRow?.['归属单位'] }}）。
            送检日期与现场复核日期冲突时，以现场复核日期为准。
          </p>
          <label class="form-item">
            <span>现场复核日期</span>
            <input v-model="form.reviewDate" type="date" required />
          </label>
          <div class="modal-actions">
            <button class="btn primary" type="submit">确认复核</button>
            <button class="btn ghost" type="button" @click="closeDialog">取消</button>
          </div>
        </form>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  fieldReviewFlotation,
  isReadOnlyRow,
  listFlotationRows,
  runLabAction,
  submitFlotationSample,
} from '@/api/flotation-service'
import { downloadEntries, filterRows, moduleMeta } from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('flotation')
const store = useSessionStore()
const isLab = computed(() => store.isLab)
const roleLabel = computed(() => store.roleLabel)

const columns = ["样本编号", "采样单位", "归属单位", "采样层位", "土样重量", "浮选日期", "轻浮物类型", "现场复核日期", "分拣结果", "操作人"]
const labActionsByStatus: Record<string, string> = {
  已采集: "执行浮选",
  已浮选: "完成分拣",
  已分拣: "送出检测",
}
const statuses = ["已采集", "已浮选", "已分拣", "已送检", "已返回"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["样本编号", "采样单位", "采样层位"]

const dialogMode = ref<'' | 'create' | 'review'>('')
const dialogRow = ref<EntryRow | null>(null)
const form = reactive({ sampleCode: '', layer: '', weight: '', reviewDate: todayValue() })

const stats = computed(() => {
  const floated = rows.value.filter((row) =>
    ["已浮选", "已分拣", "已送检", "已返回"].includes(String(row.status)),
  ).length
  const pendingSort = rows.value.filter((row) => String(row.status) === "已浮选").length
  return [
    { label: "样本总数", value: rows.value.length },
    { label: "已浮选数", value: floated },
    { label: "待分拣数", value: pendingSort },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function todayValue(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function isReadOnly(row: EntryRow): boolean {
  return isReadOnlyRow(row, store.snapshot())
}

// 职责边界：检测室按状态顺序作业；现场组只能复核本单位样本；跨单位现场组没有任何动作。
function rowActions(row: EntryRow): string[] {
  if (store.role === 'lab') {
    const action = labActionsByStatus[String(row.status)]
    return action ? [action] : []
  }
  return isReadOnly(row) ? [] : ['现场复核']
}

function lastLog(row: EntryRow): string {
  const lines = String(row['操作记录'] ?? '').split('\n').filter(Boolean)
  return lines.length ? lines[lines.length - 1] : '—'
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
  noticeMessage.value = ''
  if (store.role === 'lab') {
    errorMessage.value = '浮选样本由现场组人员提交，检测室不能登记样本'
    return
  }
  form.sampleCode = suggestCode()
  form.layer = ''
  form.weight = ''
  form.reviewDate = todayValue()
  dialogMode.value = 'create'
}

function suggestCode(): string {
  const max = rows.value.reduce((acc, row) => {
    const match = /FLOT-(\d+)/.exec(String(row['样本编号'] ?? ''))
    return match ? Math.max(acc, Number(match[1])) : acc
  }, 0)
  return `FLOT-${String(max + 1).padStart(4, '0')}`
}

function closeDialog() {
  dialogMode.value = ''
  dialogRow.value = null
}

function confirmCreate() {
  const result = submitFlotationSample({
    sampleCode: form.sampleCode,
    unit: store.unit,
    layer: form.layer,
    weight: form.weight,
    session: store.snapshot(),
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  closeDialog()
  noticeMessage.value = result.message
  reload()
}

function confirmReview() {
  if (!dialogRow.value) {
    return
  }
  const result = fieldReviewFlotation(Number(dialogRow.value.id), form.reviewDate, store.snapshot())
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  closeDialog()
  noticeMessage.value = result.message
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  if (action === '现场复核') {
    form.reviewDate = String(row['现场复核日期'] ?? '') || todayValue()
    dialogRow.value = row
    dialogMode.value = 'review'
    return
  }
  const result = runLabAction(Number(row.id), action, store.snapshot())
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  noticeMessage.value = ''
  try {
    // 领域服务负责历史数据迁移（回填归属单位），通用检索仍走既有筛选逻辑。
    const matched = filterRows(listFlotationRows(), filters.value)
    rows.value = matched
    total.value = matched.length
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '浮选采样列表读取失败'
  }
}

onMounted(reload)
</script>
