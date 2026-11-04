import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export interface Config {
  retainSessionState: Volatile<boolean>
  restoreOnRestart: Volatile<boolean>
}

export const Config = z.object({
  retainSessionState: z.boolean().default(true).volatile(),
  restoreOnRestart: z.boolean().default(false).volatile(),
})
