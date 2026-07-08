# Typed GDScript reference

Source: the official Godot docs on static typing and the GDScript warning
system, condensed for writing warning-free Godot 4.x code.

## What can be a type hint

1. `Variant` — any type. Rarely useful on variables, but as a return type it
   forces the function to explicitly return a value. Use it as the honest
   annotation for genuinely dynamic values (e.g. parsed JSON) before
   narrowing.
2. `void` — return type only; the function returns nothing.
3. Built-in types (`int`, `float`, `String`, `StringName`, `Vector2i`,
   `PackedStringArray`, ...).
4. Native classes (`Object`, `Node`, `Area2D`, ...).
5. Global classes registered with `class_name`.
6. Inner classes (`class Foo: ...` inside a script).
7. Global, native, and custom named enums. An enum type is just an `int` —
   nothing guarantees a value belongs to the enum's set, so validate values
   coming from outside the type system.
8. Constants holding a preloaded class or enum
   (`const Rifle = preload("res://weapons/rifle.gd")` → `var r: Rifle`).

Prefer `class_name` over `preload` constants for types used across several
files: it registers the type globally and removes path coupling.

## Declaration forms

```gdscript
var damage: float = 10.5          # explicit — required for fields/API surface
var damage := 10.5                # inferred — fine for locals with obvious RHS
const MOVE_SPEED: float = 50.0    # constants infer without ':', but annotate
                                  # typed arrays: const IDS: Array[int] = [1, 2]
func sum(a: float = 0.0, b: float = 0.0) -> float:
    return a + b
```

For constants `=` and `:=` are identical; the annotation on a `const` is for
readers and for element types of collections (an unannotated
`const A = [1, 2, 3]` is an untyped Array).

### Nullable return contracts

A function annotated with a built-in value type (`-> Dictionary`,
`-> Array`, `-> int`, ...) **cannot `return null`** — the analyzer rejects
it at parse time. Only Object-derived types (`-> Node`, `-> RefCounted`,
custom classes) are nullable. For a "value or null" contract, annotate
`-> Variant` and document the contract in a `##` comment; callers narrow
with a null check. Alternatives worth preferring when you control the API:
return an empty value plus a query method (`has_result()`), or model the
result as a small class whose absence is `null` under an Object-typed
return.

### Inheritance: covariance and contravariance

When overriding a method, the return type may be more specific (covariant)
and parameter types may be less specific (contravariant) than the parent's —
the Liskov substitution principle.

## Typed collections

```gdscript
var scores: Array[int] = [10, 20, 30]
var fruit_costs: Dictionary[String, int] = {"apple": 5, "orange": 10}
var item_tiles: Dictionary[Vector2i, Item] = {}
```

- Typed `Dictionary[K, V]` requires **Godot 4.4+**. Typed `Array[T]` works
  in all of 4.x. Check `config/features` in `project.godot` when unsure
  which minor version the project targets.
- Element types may be built-ins, native or custom classes, and enums.
- The element type covers `for` loop variables, `[]` indexing, `[...]=`
  assignment, and `+` (arrays). **Methods such as `push_back()` and
  operators such as `==` remain untyped** — a typed collection narrows most
  but not all operations, so keep the values flowing into it typed as well.
- **Nested generics are a syntax error**: no `Array[Array[int]]`, no
  `Dictionary[String, Dictionary[String, int]]`. Work around it with:
  - outer `Array[Array]` / `Dictionary[K, Dictionary]` plus a typed local at
    the point of use: `var row: Array[int] = grid[y]`
  - or a small wrapper class with a typed field, when the inner structure
    has meaning worth naming.
- You cannot annotate individual elements inside a literal
  (`[$Goblin: Enemy]` is a syntax error) — type the collection, not the
  elements.

### Loop variables

Since 4.2 the loop variable itself can be annotated, which types it even
when the iterable is untyped:

```gdscript
for name: String in names:
    ...
for i: int in range(WIDTH):
    ...
```

Do this whenever the iterable is not a typed collection.

## Casting and narrowing

`as` casts and sticks the type to the variable:

```gdscript
var player := body as PlayerController
if not player:
    return
player.damage()
```

- With **custom/native classes**, a failed `as` silently yields `null` — no
  error, no warning. Always pair `as` with a null check, and reserve it for
  when "absent on mismatch" is the behavior you want.
- With **built-in types**, a failed cast raises a runtime error instead.

The safer default is `is` narrowing into a typed local:

```gdscript
if body is not PlayerController:
    push_error("Bug: body is not PlayerController.")
    return
var player: PlayerController = body
player.damage()
```

`assert(body is PlayerController, "...")` also works for conditions that are
programmer-error-only — remember `assert` is stripped from release builds,
so never put required side effects or user-input validation in it.

### Safe lines vs reliable lines

The editor marks lines green ("safe") when it can prove the types. Safe is
not the same as reliable:

```gdscript
@onready var node_1 := $Node1 as Type1   # safe line, but nulls silently
@onready var node_2: Type2 = $Node2      # unsafe line, but fails loudly
```

Prefer the second form for node references: if the scene's node type stops
matching the script, the error fires at scene load, at the cause — not later
at some distant null dereference.

## Remediating UNSAFE\_\* warnings

### UNSAFE_PROPERTY_ACCESS / UNSAFE_METHOD_ACCESS

Fired when accessing a member that the _declared_ type doesn't have.
Duck-typed guards (`if "prop" in obj:` / `obj.has_method("f")`) do **not**
silence it — the analyzer still can't see the type. Narrow instead:

```gdscript
if node_2d is MyScript:
    var my_script: MyScript = node_2d
    my_script.some_property = 20
    my_script.some_function()
```

or `var my_script := node_2d as MyScript` followed by
`if my_script != null:`.

### UNSAFE_CAST

Fired when casting a `Variant` expression whose type the analyzer can't
verify (e.g. `(body.label as Label)` where `label` came from an untyped
access). Fetch into a `Variant`, prove the type with `is`, then bind:

```gdscript
var label_variant: Variant = body.get("label")
if label_variant is Label:
    var label: Label = label_variant
    label.text = name
```

### UNSAFE_CALL_ARGUMENT

Fired when passing a `Variant`/looser-typed value to a typed parameter.
Narrow the value first (same `is`/`as` patterns as above), or fix the
producer so it returns a typed value to begin with — chasing casts at every
call site usually means one untyped declaration upstream.

## Typed builtin counterparts

The Variant-typed global functions have typed equivalents. Using them keeps
lines safe and compiles to faster typed instructions:

| Untyped     | Typed counterparts                                                          |
| ----------- | --------------------------------------------------------------------------- |
| `abs()`     | `absf()`, `absi()`, `Vector2.abs()`, `Vector2i.abs()`, `Vector3.abs()`, ... |
| `ceil()`    | `ceilf()`, `ceili()`, `Vector2.ceil()`, ...                                 |
| `clamp()`   | `clampf()`, `clampi()`, `Vector2.clamp()`, ..., `Color.clamp()`             |
| `floor()`   | `floorf()`, `floori()`, `Vector2.floor()`, ...                              |
| `lerp()`    | `lerpf()`, `Vector2.lerp()`, ..., `Color.lerp()`, `Quaternion.slerp()`      |
| `round()`   | `roundf()`, `roundi()`, `Vector2.round()`, ...                              |
| `sign()`    | `signf()`, `signi()`, `Vector2.sign()`, ...                                 |
| `snapped()` | `snappedf()`, `snappedi()`, `Vector2.snapped()`, ...                        |

Rule of thumb: if you write `abs(`, `clamp(`, `lerp(`, `floor(`, `ceil(`,
`round(`, `sign(`, or `snapped(` on typed operands, reach for the suffixed
or method form instead.

## Warning system configuration

Warnings live in Project Settings under **Debug > GDScript**
(`debug/gdscript/warnings/*` in `project.godot`; Advanced Settings must be
on to see them in the UI). Each warning takes `0` (ignore), `1` (warn), or
`2` (error — the project won't compile until fixed).

Engine quirk worth knowing: at `1`, warnings render in the editor's script
panel but are **not printed by headless runs** (`--import`, `--check-only`,
or running the game). To surface them on a command line they must be
escalated to `2`, where they appear as
`SCRIPT ERROR: Parse Error: ... (Warning treated as error.)`. Any CI or
script-based warning gate must therefore check with the settings at `2` —
this skill's `scripts/check.sh` does exactly that, temporarily.

The strict set this skill enables:

- `untyped_declaration` — a declaration with no static type. The core
  warning; everything else assumes this is on.
- `unsafe_property_access`, `unsafe_method_access`, `unsafe_cast`,
  `unsafe_call_argument` — the UNSAFE\_\* family above.

Optional, stricter still: `inferred_declaration` flags every `:=`. Enable it
only if the project's convention is fully explicit annotations; this skill's
convention permits `:=` for locals with obvious right-hand sides.

Suppression annotations (names match the setting names):

```gdscript
@warning_ignore("untyped_declaration")  # one line
@warning_ignore_start("unsafe_cast")    # region...
@warning_ignore_restore("unsafe_cast")  # ...end
```

Use these per-line and with a comment explaining the constraint (e.g. an
engine API that returns `Variant` with no typed alternative). A suppression
without a reason is a warning you've hidden, not fixed.
