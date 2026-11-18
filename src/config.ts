import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export interface Config {
  restoreOnRestart: Volatile<boolean>
}

export const Config = z.object({
  restoreOnRestart: z.boolean().default(false).volatile(),
})
