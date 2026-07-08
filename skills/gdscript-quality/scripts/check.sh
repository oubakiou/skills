#!/usr/bin/env bash
# Headless GDScript quality gate.
#
# Godot's analyzer emits GDScript warnings to the console only when they are
# escalated to errors (value 2, "Warning treated as error"); at value 1 they
# are visible in the editor but silent in headless runs. So this script
# temporarily escalates the strict warning set to errors in project.godot
# (restored afterward, also on interrupt), runs --import to build the global
# class cache, then validates every .gd file with --check-only.
#
# Usage: check.sh <project_dir>
# Env:   GODOT_BIN  godot binary to use (default: godot)
# Exit:  0 clean / 1 findings / 2 usage error / 3 godot binary unavailable
#
# Third-party code under addons/ is skipped: it is not yours to fix and its
# warnings would drown out your own.
set -uo pipefail

PROJECT_DIR="${1:-}"
if [[ -z "$PROJECT_DIR" || ! -f "$PROJECT_DIR/project.godot" ]]; then
	echo "usage: check.sh <project_dir>   (must contain project.godot)" >&2
	exit 2
fi

GODOT_BIN="${GODOT_BIN:-godot}"
if ! command -v "$GODOT_BIN" >/dev/null 2>&1; then
	echo "error: godot binary '$GODOT_BIN' not found; set GODOT_BIN or install Godot 4.x" >&2
	echo "verification SKIPPED — do not report the project as verified" >&2
	exit 3
fi

WARNING_KEYS=(
	untyped_declaration
	unsafe_property_access
	unsafe_method_access
	unsafe_cast
	unsafe_call_argument
)

PROJECT_FILE="$PROJECT_DIR/project.godot"
BACKUP_FILE="$(mktemp "${PROJECT_FILE}.check-backup.XXXXXX")"
cp "$PROJECT_FILE" "$BACKUP_FILE"

restore_project_file() {
	if [[ -f "$BACKUP_FILE" ]]; then
		mv -f "$BACKUP_FILE" "$PROJECT_FILE"
	fi
}
trap restore_project_file EXIT

# Appending a [debug] section at the end overrides any earlier values for the
# same keys, so this forces error escalation regardless of project settings.
{
	printf '\n[debug]\n\n'
	for key in "${WARNING_KEYS[@]}"; do
		printf 'gdscript/warnings/%s=2\n' "$key"
	done
} >>"$PROJECT_FILE"

FINDINGS_FILE="$(mktemp)"
STDERR_FILE="$(mktemp)"
cleanup_tmp() { rm -f "$FINDINGS_FILE" "$STDERR_FILE"; }

# Pass 1: import — builds the class_name cache --check-only needs, and
# surfaces scene/resource-level errors. Script errors are excluded here
# because pass 2 reports them per file (with the file identified).
"$GODOT_BIN" --headless --path "$PROJECT_DIR" --import >/dev/null 2>"$STDERR_FILE"
IMPORT_EXIT=$?
grep 'ERROR' "$STDERR_FILE" |
	grep -vE 'SCRIPT ERROR|Parse Error|GDScript::reload|Failed to load script' |
	sed 's/^/[import] /' >>"$FINDINGS_FILE"

# Pass 2: validate every first-party .gd file individually, so scripts not
# referenced by any scene are checked too. The "at:" lines carry file:line.
CHECKED_COUNT=0
while IFS= read -r gd_file; do
	rel_path="${gd_file#"$PROJECT_DIR"/}"
	CHECKED_COUNT=$((CHECKED_COUNT + 1))
	"$GODOT_BIN" --headless --path "$PROJECT_DIR" --check-only --script "res://$rel_path" \
		>/dev/null 2>"$STDERR_FILE"
	if [[ $? -ne 0 ]]; then
		grep -E 'SCRIPT ERROR|Parse Error| at: ' "$STDERR_FILE" |
			grep -v 'modules/gdscript' | sed "s|^|[$rel_path] |" >>"$FINDINGS_FILE"
	fi
done < <(find "$PROJECT_DIR" -name '*.gd' -type f -not -path '*/.godot/*' -not -path '*/addons/*' | sort)

restore_project_file

SCRIPT_ERROR_COUNT="$(grep -c 'SCRIPT ERROR' "$FINDINGS_FILE")"
IMPORT_ERROR_COUNT="$(grep -c '^\[import\]' "$FINDINGS_FILE")"

if [[ -s "$FINDINGS_FILE" ]]; then
	echo "== findings =="
	cat "$FINDINGS_FILE"
fi
echo "== summary =="
echo "scripts checked: $CHECKED_COUNT"
echo "import exit code: $IMPORT_EXIT"
echo "script errors (incl. warnings-as-errors): $SCRIPT_ERROR_COUNT"
echo "import-level error lines: $IMPORT_ERROR_COUNT"

cleanup_tmp

if [[ "$SCRIPT_ERROR_COUNT" -gt 0 || "$IMPORT_ERROR_COUNT" -gt 0 || "$IMPORT_EXIT" -ne 0 ]]; then
	echo "RESULT: NOT CLEAN — fix the findings above and re-run"
	exit 1
fi
echo "RESULT: CLEAN"
