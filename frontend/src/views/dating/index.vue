<template>
  <section class="page" data-module="dating">
    <header class="page-head">
      <div>
        <h2>测年送检管理</h2>
        <p class="page-desc">浮选完成后自动生成待补样记录；送检日期与现场复核日期冲突时，以现场复核日期为准。送检由检测室办理。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" :disabled="!isLab" :title="isLab ? '' : '测年送检由检测室登记'" @click="openCreate">登记测年送检单</button>
        <button class="btn" type="button" @click="exportRows">导出测年送检清单</button>
      </div>
    </header>

    <p class="boundary-banner" :class="isLab ? 'banner-lab' : 'banner-field'">
      当前身份：<strong>{{ roleLabel }} · {{ store.unit }}</strong>
      <template v-if="isLab">（可办理补齐样品、送出检测、登记结果与归档）</template>
      <template v-else>（送检由检测室办理，现场组只读）</template>
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
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
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
            <span v-else-if="!isLab" class="muted-text">只读</span>
            <span v-else>—</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无测年送检数据，浮选执行后会自动生成待补样记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条测年送检记录</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, filterRows, listEntries, moduleMeta } from '@/api/local-service'
import { runDatingAction } from '@/api/flotation-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('dating')
const store = useSessionStore()
const isLab = computed(() => store.isLab)
const roleLabel = computed(() => store.roleLabel)

const columns = ["送检编号", "样品类型", "采样单位", "采样层位", "来源样本编号", "送检方法", "送检日期", "预计返回", "日期核对说明"]
const statuses = ["待补样", "待送检", "已送检", "检测中", "已出结果", "已归档"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["送检编号", "采样单位", "来源样本编号"]

const stats = computed(() => [
  { label: "送检总数", value: rows.value.length },
  { label: "待补样数", value: rows.value.filter((row) => String(row.status) === "待补样").length },
  { label: "检测中数", value: rows.value.filter((row) => String(row.status) === "检测中").length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 状态决定可执行动作：待补样必须先补齐样品；现场组在本页没有任何动作。
function rowActions(row: EntryRow): string[] {
  if (!isLab.value) {
    return []
  }
  switch (String(row.status)) {
    case '待补样':
      return ['补齐样品']
    case '待送检':
      return ['送出检测']
    case '已送检':
      return ['登记结果']
    case '已出结果':
      return ['归档报告']
    default:
      return []
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '测年送检单登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = runDatingAction(Number(row.id), action, store.snapshot())
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
    const matched = filterRows(listEntries(meta.key).items, filters.value)
    rows.value = matched
    total.value = matched.length
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '测年送检列表读取失败'
  }
}

onMounted(reload)
</script>
