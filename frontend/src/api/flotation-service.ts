import { listRows, saveRows } from '@/data/local-store'
import { runAction as genericRunAction } from '@/api/local-service'
import type { ActionResult, EntryRow } from '@/data/types'
import type { SessionSnapshot } from '@/stores/session'

// 浮选采样的跨页联动与职责边界统一在这里处理，页面只负责调用。
// 现场组：提交浮选样本、本单位样本现场复核；检测室：执行浮选、完成分拣、送出检测。
// 现场组跨单位访问样本时只读；检测室不归属现场单位，可对各单位送检来的样本作业。
// 历史浮选样本不重新划拨单位，沿用原登记单位（迁移时由 采样单位 回填 归属单位）。

const KEY = 'flotation'
const DATING_KEY = 'dating'

export const FLOTATION_STATUSES = ['已采集', '已浮选', '已分拣', '已送检', '已返回'] as const
export type FlotationStatus = (typeof FLOTATION_STATUSES)[number]

// 检测室动作到目标状态的顺序映射：不允许跳着做（例如未浮选不能直接分拣）。
const LAB_TRANSITIONS: Record<string, FlotationStatus> = {
  执行浮选: '已浮选',
  完成分拣: '已分拣',
  送出检测: '已送检',
}
// 状态在流转链中的序号，用于顺序校验。
const STATUS_ORDER: Record<FlotationStatus, number> = Object.fromEntries(
  FLOTATION_STATUSES.map((status, index) => [status, index]),
) as Record<FlotationStatus, number>

function pad4(value: number): string {
  return String(value).padStart(4, '0')
}

function today(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function appendLog(row: EntryRow, line: string): void {
  const previous = String(row['操作记录'] ?? '').trim()
  row['操作记录'] = previous ? `${previous}\n${line}` : line
}

// 兼容历史数据：老记录没有归属单位与操作记录，按原登记单位回填，绝不重新划拨。
export function normalizeFlotationRow(row: EntryRow): EntryRow {
  const next: EntryRow = { ...row }
  if (!next['归属单位']) {
    next['归属单位'] = String(next['采样单位'] ?? '未登记单位')
  }
  if (!next['提交人']) {
    next['提交人'] = '历史数据'
  }
  if (!next['操作记录']) {
    next['操作记录'] = `历史样本，按原登记单位「${next['归属单位']}」归属`
  }
  return next
}

export function listFlotationRows(): EntryRow[] {
  return listRows(KEY).map(normalizeFlotationRow)
}

export function canRead(session: SessionSnapshot): boolean {
  return session.name.length > 0
}

// 现场组只能写本单位样本；检测室可以写所有单位（浮选、分拣、送检是检测室的职责）。
export function isReadOnlyRow(row: EntryRow, session: SessionSnapshot): boolean {
  if (session.role === 'lab') {
    return false
  }
  return String(row['归属单位'] ?? '') !== session.unit
}

function findRow(rows: EntryRow[], id: number): number {
  return rows.findIndex((row) => Number(row.id) === id)
}

function maxId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)
}

function findDatingByFlotation(datingRows: EntryRow[], flotationId: number): EntryRow | undefined {
  return datingRows.find((row) => Number(row['关联浮选编号']) === flotationId)
}

function sortingResult(row: EntryRow): string {
  // 分拣结果只由样本自身派生：重复点击产出的永远是同一份，不会出现第二份。
  return `炭化植物遗存（来源 ${row['样本编号']}）`
}

// 现场组提交浮选样本：只有现场组能登记，检测室没有提交入口。
export function submitFlotationSample(input: {
  sampleCode: string
  unit: string
  layer: string
  weight: string
  session: SessionSnapshot
}): ActionResult {
  const { sampleCode, unit, layer, weight, session } = input
  if (session.role !== 'field') {
    return { ok: false, message: '浮选样本由现场组人员提交，检测室不能登记样本' }
  }
  if (!unit.trim() || unit.trim() !== session.unit) {
    return { ok: false, message: `现场组只能提交本单位（${session.unit}）的浮选样本` }
  }
  if (!sampleCode.trim() || !layer.trim() || !weight.trim()) {
    return { ok: false, message: '样本编号、采样层位、土样重量不能为空' }
  }
  const rows = listFlotationRows()
  if (rows.some((row) => String(row['样本编号']) === sampleCode.trim())) {
    return { ok: false, message: `样本编号 ${sampleCode.trim()} 已存在` }
  }
  const stamp = today()
  const id = maxId(rows) + 1
  const row: EntryRow = {
    id,
    status: '已采集',
    pending: true,
    abnormal: false,
    样本编号: sampleCode.trim(),
    采样单位: unit.trim(),
    归属单位: session.unit,
    采样层位: layer.trim(),
    土样重量: weight.trim(),
    浮选日期: '',
    轻浮物类型: '',
    操作人: session.name,
    提交人: session.name,
    现场复核日期: '',
    分拣结果: '',
    操作记录: '',
  }
  appendLog(row, `${stamp} ${session.name} 提交样本（${session.unit}），状态：已采集`)
  saveRows(KEY, [...rows, row])
  return { ok: true, message: `浮选样本 ${sampleCode.trim()} 已提交，等待检测室浮选` }
}

// 本单位现场复核：只登记复核日期，不改样本状态；检测室与外单位不能复核。
export function fieldReviewFlotation(
  id: number,
  reviewDate: string,
  session: SessionSnapshot,
): ActionResult {
  if (session.role !== 'field') {
    return { ok: false, message: '现场复核由现场组执行，检测室不能代为复核' }
  }
  const rows = listFlotationRows()
  const index = findRow(rows, id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的浮选样本` }
  }
  if (isReadOnlyRow(rows[index], session)) {
    return { ok: false, message: `该样本归属${rows[index]['归属单位']}，跨单位只能只读` }
  }
  const stamp = today()
  const updated: EntryRow = { ...rows[index], 现场复核日期: reviewDate }
  appendLog(updated, `${stamp} ${session.name} 现场复核，复核日期：${reviewDate}`)
  const next = [...rows]
  next[index] = updated
  saveRows(KEY, next)
  return { ok: true, message: `样本 ${updated['样本编号']} 已登记现场复核日期` }
}

// 检测室执行浮选 / 完成分拣 / 送出检测。
export function runLabAction(
  id: number,
  action: keyof typeof LAB_TRANSITIONS | string,
  session: SessionSnapshot,
): ActionResult {
  if (session.role !== 'lab') {
    return { ok: false, message: `${action}由检测室执行，现场组没有该操作权限` }
  }
  const target = LAB_TRANSITIONS[action]
  if (!target) {
    return { ok: false, message: `浮选样本没有登记「${action}」这个检测室动作` }
  }
  const rows = listFlotationRows()
  const index = findRow(rows, id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的浮选样本` }
  }
  const current = String(rows[index].status) as FlotationStatus
  const targetOrder = STATUS_ORDER[target]
  const currentOrder = STATUS_ORDER[current] ?? -1
  if (currentOrder >= targetOrder) {
    // 完成分拣的幂等保护：已经分拣/送检/返回的，不再产出第二份分拣结果。
    if (action === '完成分拣' && currentOrder >= STATUS_ORDER['已分拣']) {
      return { ok: false, message: `样本已分拣，分拣结果只有一份，重复操作不会再生成` }
    }
    return { ok: false, message: `样本当前为「${current}」，不能再执行「${action}」` }
  }
  if (targetOrder !== currentOrder + 1) {
    return { ok: false, message: `请先完成「${FLOTATION_STATUSES[targetOrder - 1]}」，不能跳到「${action}」` }
  }

  const stamp = today()
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== FLOTATION_STATUSES[FLOTATION_STATUSES.length - 1],
  }

  if (action === '执行浮选') {
    updated['浮选日期'] = stamp
    updated['操作人'] = session.name
    appendLog(updated, `${stamp} ${session.name} 执行浮选，状态：已浮选`)
    const message = syncDatingBacklog(updated, stamp, session.name)
    return persistFlotation(rows, index, updated, message)
  }

  if (action === '完成分拣') {
    // 第二重保险：分拣结果字段若已有内容，直接复用，绝不覆盖或追加。
    const result = String(updated['分拣结果'] ?? '').trim() || sortingResult(updated)
    updated['分拣结果'] = result
    updated['操作人'] = session.name
    appendLog(updated, `${stamp} ${session.name} 完成分拣，分拣结果：${result}`)
    return persistFlotation(rows, index, updated, `样本已分拣，分拣结果已登记（仅一份）`)
  }

  // 送出检测：沿测年送检入口同步关联送检单。
  updated['操作人'] = session.name
  appendLog(updated, `${stamp} ${session.name} 送出检测，状态：已送检`)
  const message = syncDatingOnSend(updated, stamp, session.name)
  return persistFlotation(rows, index, updated, message)
}

function persistFlotation(
  rows: EntryRow[],
  index: number,
  updated: EntryRow,
  message: string,
): ActionResult {
  const next = [...rows]
  next[index] = updated
  saveRows(KEY, next)
  return { ok: true, message }
}

// 执行浮选后，在测年送检页同步生成一条「待补样」记录；重复浮选不产生第二条。
function syncDatingBacklog(flotationRow: EntryRow, stamp: string, operator: string): string {
  const datingRows = [...listRows(DATING_KEY)]
  const flotationId = Number(flotationRow.id)
  if (findDatingByFlotation(datingRows, flotationId)) {
    return `样本已浮选；测年送检的待补样记录已存在，不重复生成`
  }
  const id = maxId(datingRows) + 1
  const datingRow: EntryRow = {
    id,
    status: '待补样',
    pending: true,
    abnormal: false,
    送检编号: `DATI-${pad4(id)}`,
    样品类型: '浮选炭样',
    采样单位: String(flotationRow['采样单位'] ?? flotationRow['归属单位'] ?? ''),
    采样层位: String(flotationRow['采样层位'] ?? ''),
    送检方法: '',
    送检日期: '',
    预计返回: '',
    关联浮选编号: flotationId,
    来源样本编号: String(flotationRow['样本编号'] ?? ''),
    日期核对说明: '浮选已完成，待检测室补齐测年样品',
    操作记录: `${stamp} ${operator} 浮选样本 ${flotationRow['样本编号']}，自动生成待补样记录`,
  }
  saveRows(DATING_KEY, [...datingRows, datingRow])
  const linked: EntryRow = { ...flotationRow, 关联送检编号: datingRow['送检编号'] }
  return `样本已浮选，测年送检页已生成待补样记录 ${datingRow['送检编号']}`
}

// 送出检测时更新关联送检单。
// 日期冲突规则：送检日期与现场复核日期不一致时，以现场复核日期为准（现场交接是实物证据时点），
// 自动回正送检日期并在送检单上留痕说明。
function syncDatingOnSend(flotationRow: EntryRow, stamp: string, operator: string): string {
  const flotationId = Number(flotationRow.id)
  const datingRows = [...listRows(DATING_KEY)]
  const index = datingRows.findIndex((row) => Number(row['关联浮选编号']) === flotationId)
  const reviewDate = String(flotationRow['现场复核日期'] ?? '').trim()

  if (index < 0) {
    // 没有待补样记录（历史样本）就补一条已送检的，沿用浮选已完成时的联动口径。
    const id = maxId(datingRows) + 1
    const datingRow: EntryRow = {
      id,
      status: '已送检',
      pending: true,
      abnormal: false,
      送检编号: `DATI-${pad4(id)}`,
      样品类型: '浮选炭样',
      采样单位: String(flotationRow['采样单位'] ?? flotationRow['归属单位'] ?? ''),
      采样层位: String(flotationRow['采样层位'] ?? ''),
      送检方法: '碳十四测年',
      送检日期: reviewDate || stamp,
      预计返回: '',
      关联浮选编号: flotationId,
      来源样本编号: String(flotationRow['样本编号'] ?? ''),
      日期核对说明: '随浮选样本送出检测',
      操作记录: `${stamp} ${operator} 浮选样本送出检测，补建送检单`,
    }
    saveRows(DATING_KEY, [...datingRows, datingRow])
    return `样本已送检，测年送检页已补建送检单 ${datingRow['送检编号']}`
  }

  const datingRow: EntryRow = { ...datingRows[index], status: '已送检', pending: true }
  let note = '浮选样本已送出检测'
  if (reviewDate) {
    const declared = String(datingRow['送检日期'] ?? '').trim()
    if (!declared) {
      datingRow['送检日期'] = reviewDate
      note = `送检日期按现场复核日期 ${reviewDate} 登记`
    } else if (declared !== reviewDate) {
      // 冲突：以现场复核日期为准。
      datingRow['送检日期'] = reviewDate
      note = `送检日期 ${declared} 与现场复核日期 ${reviewDate} 冲突，以现场复核日期为准`
    }
  } else if (!datingRow['送检日期']) {
    datingRow['送检日期'] = stamp
  }
  if (!datingRow['送检方法']) {
    datingRow['送检方法'] = '碳十四测年'
  }
  datingRow['日期核对说明'] = note
  const previousLog = String(datingRow['操作记录'] ?? '').trim()
  datingRow['操作记录'] = `${previousLog ? `${previousLog}\n` : ''}${stamp} ${operator} 浮选样本送出检测；${note}`
  const next = [...datingRows]
  next[index] = datingRow
  saveRows(DATING_KEY, next)
  return `样本已送检，送检单 ${datingRow['送检编号']} 已同步（${note}）`
}

// 测年页「补齐样品」：待补样 → 待送检，仍需检测室送出，不自动跳过流程。
export function supplementDatingSample(id: number, session: SessionSnapshot): ActionResult {
  if (session.role !== 'lab') {
    return { ok: false, message: '补齐测年样品由检测室执行' }
  }
  const rows = [...listRows(DATING_KEY)]
  const index = findRow(rows, id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的测年送检单` }
  }
  if (String(rows[index].status) !== '待补样') {
    return { ok: false, message: '只有待补样的送检单需要补齐样品' }
  }
  const stamp = today()
  const updated: EntryRow = { ...rows[index], status: '待送检' }
  updated['日期核对说明'] = '测年样品已补齐，待送出检测'
  const previousLog = String(updated['操作记录'] ?? '').trim()
  updated['操作记录'] = `${previousLog ? `${previousLog}\n` : ''}${stamp} ${session.name} 补齐测年样品，状态：待送检`
  const next = [...rows]
  next[index] = updated
  saveRows(DATING_KEY, next)
  return { ok: true, message: `送检单 ${updated['送检编号']} 已补齐样品，可送出检测` }
}

// 测年页动作入口：补齐样品走专用流程，其余沿用通用状态流转，但必须先补齐待补样、且只有检测室能操作。
export function runDatingAction(id: number, action: string, session: SessionSnapshot): ActionResult {
  if (session.role !== 'lab') {
    return { ok: false, message: '测年送检由检测室办理，现场组只读' }
  }
  if (action === '补齐样品') {
    return supplementDatingSample(id, session)
  }
  const rows = listRows(DATING_KEY)
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的测年送检单` }
  }
  if (String(row.status) === '待补样') {
    return { ok: false, message: '该送检单待补样，请先补齐样品再送出检测' }
  }
  return genericRunAction(DATING_KEY, id, action)
}
