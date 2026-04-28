/**
 * guarded-webfetch-claude の sanitize.ts を re-export する
 *
 * sanitize.ts は guarded-webfetch-claude 側で一元管理する。
 * 本スキル (guarded-websearch-claude) は import 経由で共有使用する。
 *
 * 注意: この依存により、guarded-webfetch-claude が存在しない環境では
 * 本スキルは動作しない（skill の独立性に関するトレードオフ）。
 * 詳細は references/design-plan.md セクション 2 を参照。
 */
export { sanitize } from '../../guarded-webfetch-claude/scripts/sanitize.ts'
export type { SanitizeFlags } from '../../guarded-webfetch-claude/scripts/sanitize.ts'
