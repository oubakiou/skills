/**
 * guarded-webfetch-gemini の sanitize.ts を re-export する
 *
 * sanitize.ts は guarded-webfetch-gemini 側で一元管理する。
 * 本スキル (guarded-websearch-gemini) は import 経由で共有使用する。
 *
 * 注意: この依存により、guarded-webfetch-gemini が存在しない環境では
 * 本スキルは動作しない（skill の独立性に関するトレードオフ）。
 */
export { sanitize } from '../../guarded-webfetch-gemini/scripts/sanitize.ts'
export type {
  SanitizeFlags,
  SuspiciousPatternCounts,
} from '../../guarded-webfetch-gemini/scripts/sanitize.ts'
