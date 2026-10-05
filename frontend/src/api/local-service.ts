import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  CreateResult,
  EntryRow,
  ModuleMeta,
  OperatorRef,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(
  key: string,
  id: number,
  action: string,
  operator?: OperatorRef,
): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  // 职责边界：登记了负责单位的动作只放行该单位，跨单位人员访问样本只读。
  const requiredUnit = meta.actionUnits?.[action]
  if (requiredUnit && operator?.unit !== requiredUnit) {
    return {
      ok: false,
      message: `${meta.entity}的「${action}」由${requiredUnit}人员执行，跨单位人员访问只读`,
    }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  let updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  if (key === 'flotation' && operator) {
    updated = afterFlotationAction(updated, action, operator)
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function createEntry(
  key: string,
  values: Record<string, string>,
  operator?: OperatorRef,
): CreateResult {
  const meta = moduleMeta(key)
  // 职责边界：登记入口只放行负责单位，比如浮选样本由现场人员提交。
  if (meta.createUnit && operator?.unit !== meta.createUnit) {
    return {
      ok: false,
      message: `${meta.entity}由${meta.createUnit}人员提交，跨单位人员访问只读`,
    }
  }
  const rows = listRows(key)
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const row: EntryRow = {
    id,
    status: meta.statuses[0],
    pending: true,
    abnormal: false,
    ...values,
  }
  if (key === 'flotation' && operator) {
    const prepared = prepareFlotationEntry(row, operator)
    if (!prepared.ok) {
      return prepared
    }
    saveRows(key, [...rows, prepared.row])
    return { ok: true, id, message: `${meta.entity}已登记提交，当前状态「${prepared.row.status}」` }
  }
  saveRows(key, [...rows, row])
  return { ok: true, id, message: `${meta.entity}已登记，当前状态「${row.status}」` }
}

// ---- 浮选采样：现场组提交、检测室处理，动作留痕并联动测年送检 ----

const DATING_KEY = 'dating'
const DATING_LAST_STATUS = '已归档'

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function appendLog(row: EntryRow, entry: string): string {
  const log = String(row['操作记录'] ?? '').trim()
  return log ? `${log}；${entry}` : entry
}

function nextCode(rows: EntryRow[], field: string, prefix: string): string {
  const max = rows.reduce((acc, row) => {
    const match = new RegExp(`^${prefix}-(\\d+)$`).exec(String(row[field] ?? ''))
    return match ? Math.max(acc, Number(match[1])) : acc
  }, 0)
  return `${prefix}-${String(max + 1).padStart(4, '0')}`
}

function prepareFlotationEntry(
  row: EntryRow,
  operator: OperatorRef,
): { ok: true; row: EntryRow } | { ok: false; message: string } {
  if (!String(row['采样单位'] ?? '').trim() || !String(row['采样层位'] ?? '').trim()) {
    return { ok: false, message: '采样单位、采样层位不能为空' }
  }
  const rows = listRows('flotation')
  const reviewDate = String(row['现场复核日期'] ?? '').trim() || today()
  const prepared: EntryRow = {
    ...row,
    '样本编号': nextCode(rows, '样本编号', 'FLOT'),
    '浮选日期': '',
    '操作人': operator.operator,
    '样本状态': row.status,
    '归属单位': operator.unit,
    '现场复核日期': reviewDate,
    '操作记录': `[${today()}] ${operator.unit}·${operator.operator} 登记提交 → ${row.status}`,
  }
  return { ok: true, row: prepared }
}

// 浮选动作成功后的留痕与测年送检联动；只在状态真正前进时触发，重复点击走不到这里。
function afterFlotationAction(row: EntryRow, action: string, operator: OperatorRef): EntryRow {
  let next: EntryRow = {
    ...row,
    '操作人': operator.operator,
    '操作记录': appendLog(row, `[${today()}] ${operator.unit}·${operator.operator} ${action} → ${row.status}`),
  }
  if (action === '执行浮选') {
    next = { ...next, '浮选日期': today() }
    ensureDatingDraft(next)
  }
  if (action === '完成分拣') {
    // 分拣结果只产生一份：样本到达「已分拣」后再次点击会被状态闸拦下，这里的联动也只跑一次。
    advanceLinkedDating(next, '待补样', '待送检')
  }
  if (action === '送出检测') {
    const reviewDate = String(next['现场复核日期'] ?? '')
    let sendDate = today()
    if (reviewDate && sendDate < reviewDate) {
      // 送检日期与现场复核日期冲突时以现场复核日期为准：样本不可能在复核通过前送出。
      sendDate = reviewDate
      next = {
        ...next,
        '操作记录': appendLog(
          next,
          `[${today()}] 送检日期早于现场复核日期，以现场复核日期 ${reviewDate} 为准`,
        ),
      }
    }
    markLinkedDatingSent(next, sendDate)
  }
  return next
}

function linkedDatingIndex(rows: EntryRow[], sampleNo: string): number {
  return rows.findIndex((row) => String(row['关联样本编号'] ?? '') === sampleNo)
}

// 执行浮选后同步生成一条「待补样」测年送检单；按关联样本编号去重，一个样本只生成一单。
function ensureDatingDraft(sample: EntryRow): void {
  const sampleNo = String(sample['样本编号'] ?? '')
  const rows = listRows(DATING_KEY)
  if (linkedDatingIndex(rows, sampleNo) >= 0) {
    return
  }
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const draft: EntryRow = {
    id,
    status: '待补样',
    pending: true,
    abnormal: false,
    '送检编号': nextCode(rows, '送检编号', 'DATI'),
    '样品类型': '浮选轻浮物',
    '采样单位': sample['采样单位'] ?? '',
    '采样层位': sample['采样层位'] ?? '',
    '送检方法': '碳十四测年',
    '送检日期': '',
    '预计返回': '',
    '送检状态': '待补样',
    '关联样本编号': sampleNo,
  }
  saveRows(DATING_KEY, [...rows, draft])
}

function advanceLinkedDating(sample: EntryRow, from: string, to: string): void {
  const rows = listRows(DATING_KEY)
  const index = linkedDatingIndex(rows, String(sample['样本编号'] ?? ''))
  if (index < 0 || String(rows[index].status) !== from) {
    return
  }
  const next = [...rows]
  next[index] = {
    ...rows[index],
    status: to,
    pending: to !== DATING_LAST_STATUS,
    '送检状态': to,
  }
  saveRows(DATING_KEY, next)
}

function markLinkedDatingSent(sample: EntryRow, sendDate: string): void {
  ensureDatingDraft(sample)
  const rows = listRows(DATING_KEY)
  const index = linkedDatingIndex(rows, String(sample['样本编号'] ?? ''))
  if (index < 0 || String(rows[index].status) === '已送检') {
    return
  }
  const next = [...rows]
  next[index] = {
    ...rows[index],
    status: '已送检',
    pending: true,
    '送检日期': sendDate,
    '送检状态': '已送检',
  }
  saveRows(DATING_KEY, next)
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
