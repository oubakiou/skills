---
name: gdscript-quality
license: MIT
description: >-
  Write production-quality, statically typed GDScript for Godot 4.x. Use this
  skill whenever you create, edit, refactor, or review .gd files or any Godot
  project code — even if the user does not mention types, warnings, or code
  quality ("add a feature to my Godot game" or "fix this script" counts).
  Covers type annotations, typed Arrays and Dictionaries, eliminating
  UNTYPED_*/UNSAFE_* warnings, GDScript naming and script organization, node
  access and signal patterns, and headless verification with the bundled
  check script.
---

# GDScript Quality

Produce GDScript that compiles clean under Godot's strict warnings and reads
like code written by a careful Godot engineer. Static typing is not
cosmetic: the analyzer catches real bugs before the game runs, the editor
gains full autocompletion, and typed opcodes execute faster. Untyped code
silently forfeits all three, and the cost surfaces later as runtime errors
that types would have caught at parse time.

## Workflow

1. **Enable strict warnings in `project.godot` first** (see below), so
   anyone opening the project in the editor sees the same findings the
   check script enforces.
2. **Write code following the core rules** in this file. Consult
   `references/` for anything beyond the basics (see the map below).
3. **Verify headlessly** after implementing:

   ```sh
   bash <skill_dir>/scripts/check.sh <project_dir>
   ```

   Fix every reported finding and re-run until it prints `RESULT: CLEAN`.
   If no `godot` binary is available (exit code 3), say explicitly in your
   final report that headless verification was skipped — do not present
   unverified code as verified.

### Warning configuration

Ensure `project.godot` has a `[debug]` section containing:

```ini
[debug]

gdscript/warnings/untyped_declaration=1
gdscript/warnings/unsafe_property_access=1
gdscript/warnings/unsafe_method_access=1
gdscript/warnings/unsafe_cast=1
gdscript/warnings/unsafe_call_argument=1
```

Values: `0` ignore, `1` warn, `2` error. Know one engine quirk: at `1` the
warnings appear only in the editor UI — **headless runs print nothing**.
Warnings surface on the command line only at `2`, as
`SCRIPT ERROR: ... (Warning treated as error.)`. The check script handles
this by escalating to `2` during the check, so `1` is a fine everyday
setting; use `2` in the project itself when you want the game to refuse to
run until warnings are fixed.

## Core rules

**Type every declaration.** Variables, constants, parameters, return types —
including `-> void` when a function returns nothing, and including private
helpers and loop-local temporaries. Partial typing is where bugs hide: one
untyped field turns every access on it into an unchecked `Variant` operation
that the analyzer can no longer help you with.

**Use `:=` only when the right-hand side makes the type obvious** (a literal,
a constructor call, or a cast: `var speed := 12.5`,
`var rng := RandomNumberGenerator.new()`). Fields, function signatures, and
anything part of a class's surface get explicit annotations — readers see the
type without hunting for the initializer.

**Type your collections.** `Array[Item]`, `Dictionary[Vector2i, Item]`
(typed dictionaries need Godot 4.4+ — check `config/features` in
`project.godot` first; on 4.0–4.3 keep the Dictionary untyped and type the
values at each access with typed locals or casts instead). Nested generics
(`Array[Array[int]]`) are a syntax error — declare the outer collection as
`Array[Array]` and give inner rows a typed local
(`var row: Array[int] = grid[y]`), or wrap the row in a small class.

**Never model data with untyped Dictionaries.** A dict-as-struct
(`{"hp": 10, "name": "orc"}`) has no spelling check on keys, no type on
values, and every access is unsafe. Define a `class_name` script or an inner
`class ... extends RefCounted` with typed fields instead. Reserve Dictionary
for genuinely dynamic key→value lookups, and type it when you do.

**Name your magic values.** Tuning numbers, grid sizes, thresholds, string
keys: `const MOVE_SPEED: float = 50.0`. Use `enum` for closed sets of
alternatives instead of ints or strings. (Enum types are ints underneath —
the type does not guarantee a value is a member, so validate external input.)

**Type loop variables** when the iterable is untyped:
`for i: int in range(n)`, `for line: String in lines`. A typed
`Array[T]`/`Dictionary[K, V]` already types its loop variable for you.

**Narrow `Variant`s safely.** When you receive a base type or `Variant`
(signal callbacks, `get()`, JSON), do not access members on it directly —
that is exactly what `UNSAFE_PROPERTY_ACCESS`/`UNSAFE_METHOD_ACCESS` flag.
Narrow first:

```gdscript
if body is Player:
    var player: Player = body
    player.take_damage(amount)
```

`as` also works (`var player := body as Player`) but silently yields `null`
on mismatch, so it demands an explicit null check — prefer `is` + a typed
local unless the silent-null behavior is what you want. Remediation recipes
for each UNSAFE\_\* warning are in `references/typing.md`.

**Give node references explicit types:**
`@onready var timer: Timer = $Timer`. The explicit annotation fails loudly at
scene load if the node type doesn't match; `$Timer as Timer` would silently
become `null` and blow up later, far from the cause.

**Use the typed math builtins.** `absf`/`absi`, `clampf`/`clampi`,
`floorf`/`floori`, `lerpf`, `roundf`/`roundi`, etc., instead of the Variant
`abs()`/`clamp()`/... — the untyped versions cost you both safety and speed.
Full table in `references/typing.md`.

**Type signal parameters** (`signal died(cause: StringName)`) and the
callbacks that receive them — signals are API surface too.

**Suppress warnings only as a last resort.** `@warning_ignore("...")` on a
single line, with a comment stating the constraint that makes the warning
unavoidable. If you cannot state one, fix the code instead. Never turn a
warning off project-wide to make output clean.

## Reference map

Read these on demand — not all up front:

- `references/typing.md` — the full typing reference: what can be a type
  hint, typed collection semantics and their limits, casting and `is`
  narrowing, per-warning remediation recipes (UNSAFE_PROPERTY_ACCESS,
  UNSAFE_METHOD_ACCESS, UNSAFE_CAST), typed builtin table,
  covariance/contravariance, warning-system configuration. Read when
  fighting a specific warning or typing anything non-obvious.
- `references/style.md` — naming conventions, canonical declaration order
  inside a script, formatting, `##` doc comments. Read before writing any
  new script file.
- `references/architecture.md` — separating simulation logic from Node
  presentation, node access patterns, signal design ("signals up, calls
  down"), deterministic RNG injection, and a minimal headless test-script
  pattern. Read when creating new scenes/systems or restructuring.

## Verification script

`scripts/check.sh <project_dir>` temporarily escalates this skill's strict
warning set to errors in `project.godot` (restored afterward, also on
interrupt), runs `--import` to build the class cache and catch
scene/resource errors, then validates every first-party `.gd` file with
`--check-only` — including scripts no scene references. Warnings surface as
`SCRIPT ERROR: ... (Warning treated as error.)` lines with file and line.

- Exit 0: clean. Exit 1: findings reported — fix and re-run.
- Exit 2: usage error (not a Godot project dir). Exit 3: no `godot` binary
  (`GODOT_BIN` env var overrides the binary name).
- `addons/` is skipped (third-party code is not yours to fix).
- It performs static analysis only; it does not run the game or its tests,
  so run the project's own test entry point separately if one exists.

**When findings fall outside your scope.** check.sh checks the whole
project, so it can report `NOT CLEAN` from files you did not touch and are
not allowed to touch (a fixed test oracle, pre-existing code the task
scoped you out of). In that case do not edit protected files just to
silence the gate, and do not claim the check passed. Report both facts:
the files you changed contribute zero findings, and the residual findings
are pre-existing in out-of-scope files (name them). Verify the "pre-existing"
claim before making it — confirm the same findings appear against the
original code, not just assume it.
