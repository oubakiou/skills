# GDScript style and organization

Based on the official GDScript style guide. Consistency is the point:
scripts that all follow the same shape are faster to read, and most of a
codebase's life is people reading it.

## Naming

| Thing                | Convention             | Example                          |
| -------------------- | ---------------------- | -------------------------------- |
| File names           | snake_case             | `board_model.gd`, `main.tscn`    |
| Class names          | PascalCase             | `class_name BoardModel`          |
| Node names           | PascalCase             | `ScoreLabel`, `SpawnTimer`       |
| Functions, variables | snake_case             | `func step_tick()`, `var score`  |
| Private members      | leading underscore     | `var _items`, `func _build()`    |
| Signals              | snake_case, past tense | `signal item_delivered(id: int)` |
| Constants            | CONSTANT_CASE          | `const STUCK_LIMIT: int = 5`     |
| Enum names           | PascalCase             | `enum CellKind`                  |
| Enum members         | CONSTANT_CASE          | `CellKind.BELT_LEFT`             |

Signals are named as events that already happened (`died`,
`score_changed`), never as commands (`kill`, `change_score`) — the emitter
must not know or care what listeners do.

Prefix a member with `_` when nothing outside the script should touch it.
GDScript won't enforce it, but it tells readers (and the analyzer's
autocomplete ordering) what the public surface is. Keep that surface small.

## Declaration order inside a script

```gdscript
@tool / @icon
class_name
extends
## Doc comment describing the script's purpose.

# signals
# enums
# constants
# static variables
# @export variables
# public variables
# private variables
# @onready variables

# _static_init(), static methods
# overridden built-in virtual methods:
#   _init, _enter_tree, _ready, _process, _physics_process, other _* callbacks
# public methods
# private methods
# inner classes
```

Two blank lines between functions; group related declarations with a single
blank line.

## Formatting

- Indent with **tabs** (the Godot editor default; GDScript files in the wild
  are tab-indented, and mixing styles breaks diffs).
- Keep lines ≲ 100 characters.
- One statement per line; no `if x: do_thing()` one-liners in committed
  code.
- Use `is not` / `not in` rather than `not (x is Y)` / `not (x in y)`.

## Doc comments

Use `##` (double hash) above `class_name`, signals, and public members —
these render in the editor's documentation panel. Use `#` for
implementation notes. Reserve implementation comments for the non-obvious:
hidden constraints, invariants, workarounds. Do not narrate what the code
already says.

```gdscript
## Deterministic simulation core for the conveyor board.
## Holds no scene-tree references; drive it from a Node and render the result.
class_name BoardModel
extends RefCounted
```

## Values and expressions

- Extract magic numbers and repeated strings into typed `const`s at the top
  of the script. A tuning value with a name (`SPAWN_INTERVAL`) can be found,
  reasoned about, and changed; a bare `3` in the middle of a function
  cannot.
- Use `enum` for closed sets of states/kinds; `match` over an enum reads
  better than if/elif chains and the analyzer knows the domain.
- Use `StringName` literals (`&"jump"`) for identifiers compared by
  identity (input actions, animation names, groups) — comparison is O(1)
  and typo-prone stringly APIs become greppable.
- Prefer guard clauses (`if not valid: return`) over deep nesting.
- Prefer `String.is_empty()` / `Array.is_empty()` over comparing to `""` /
  `[]`.
