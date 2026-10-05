import { defineStore } from 'pinia'

// 浮选采样的职责边界：现场组负责提交样本与现场复核，检测室负责浮选、分拣、送检。
// 现场组之间按所属单位隔离，跨单位只能只读；检测室不属于任何一个现场单位，可对所有样本作业。
export type UserRole = 'field' | 'lab'

export const LAB_UNIT = '检测室'
export const FIELD_UNITS = ['第一现场组', '第二现场组'] as const
export type FieldUnit = (typeof FIELD_UNITS)[number]

function operatorName(role: UserRole, unit: string): string {
  return role === 'lab' ? '检测室值班员' : `${unit}值班员`
}

export type SessionSnapshot = {
  name: string
  role: UserRole
  unit: string
}

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '第一现场组值班员',
    role: 'field' as UserRole,
    unit: FIELD_UNITS[0] as string,
    shiftLabel: '白班 08:00-20:00',
    scope: '田野考古发掘数字化管理系统',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    isLab: (state) => state.role === 'lab',
    roleLabel: (state) => (state.role === 'lab' ? '检测室' : '现场组'),
    identity(): string {
      return `${this.unit} · ${this.operator}`
    },
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setIdentity(role: UserRole, unit?: string) {
      this.role = role
      if (role === 'lab') {
        this.unit = LAB_UNIT
      } else if (unit) {
        this.unit = unit
      }
      this.operator = operatorName(this.role, this.unit)
    },
    snapshot(): SessionSnapshot {
      return { name: this.operator, role: this.role, unit: this.unit }
    },
  },
})
