/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

// 值班单位：现场组负责登记提交样本，检测室负责浮选、分拣、送检。
export type DutyUnit = '现场组' | '检测室'

export type OperatorRef = {
  operator: string
  unit: DutyUnit
}

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  // 动作级负责单位：登记了的动作只有该单位能执行，其他单位只读。
  actionUnits?: Record<string, DutyUnit>
  // 登记入口的负责单位：只有该单位能新建记录。
  createUnit?: DutyUnit
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type CreateResult = ActionResult & {
  id?: number
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
