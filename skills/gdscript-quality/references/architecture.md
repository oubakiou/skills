# Godot architecture patterns

How to structure scripts and scenes so the typing discipline pays off:
testable logic, loose coupling, failures near their causes.

## Separate simulation from presentation

Put game rules in plain `RefCounted` classes with `class_name`, holding no
scene-tree references. Nodes own the model, drive it, and render its
output:

```gdscript
## Pure rules: no Node, no signals into the tree, fully deterministic.
class_name BoardModel
extends RefCounted

class StepResult:
    extends RefCounted
    var tick: int
    var delivered: Array[int] = []

func step_tick() -> StepResult:
    ...
```

```gdscript
# main.gd — the Node layer
extends Node2D

var _model := BoardModel.new()

func _on_tick_timer_timeout() -> void:
    var result: BoardModel.StepResult = _model.step_tick()
    _render(result)
```

Why: logic classes constructed with `new()` run headless — no scene, no
timers — which makes them unit-testable and keeps `_process`-order and
frame-rate effects out of the rules. Inner classes (`StepResult` above) give
you typed value objects without one-file-per-struct overhead.

## Determinism: inject randomness and time

Never call global `randi()`/`randf()` inside logic classes. Hold a
`RandomNumberGenerator` and accept the seed from outside:

```gdscript
var _rng := RandomNumberGenerator.new()

func setup(rng_seed: int) -> void:
    _rng.seed = rng_seed
```

Same for time: pass tick counts or deltas in, rather than reading clocks
inside the rules. A seeded model replays identically, which turns "sometimes
flaky" bugs into reproducible test cases.

## Node access

- `@onready var timer: Timer = $Timer` — explicit type, fails at scene load
  on mismatch (see typing.md "Safe lines vs reliable lines").
- Use scene-unique names (`%ScoreLabel`) for nodes referenced from scripts,
  so rearranging the scene tree doesn't break paths.
- Deep paths (`$UI/Panel/VBox/ScoreLabel`) couple the script to the exact
  tree shape; prefer `%` names or `@export var score_label: Label` wired in
  the inspector.
- A script should reach only **down** into its own scene's children — never
  up to parents or across to siblings by path. Whoever owns both should
  wire them together.

## Signals up, calls down

Parents call children directly (they own them); children report upward by
emitting signals (they must not know who is listening):

```gdscript
signal health_changed(current: int, max: int)
signal died

func take_damage(amount: int) -> void:
    _current = maxi(_current - amount, 0)
    health_changed.emit(_current, _max)
    if _current == 0:
        died.emit()
```

Connect in `_ready` of the owner, using the typed callable form:

```gdscript
func _ready() -> void:
    _health.health_changed.connect(_on_health_changed)

func _on_health_changed(current: int, max_value: int) -> void:
    _health_label.text = "%d / %d" % [current, max_value]
```

Type signal parameters and their callbacks — a signal is API surface, and
an untyped callback reintroduces `Variant` at every emission site.

## Failure handling

- `push_error()` / `push_warning()` for recoverable, log-worthy conditions.
- `assert(condition, "message")` for programmer-error invariants only —
  asserts are stripped from release builds, so the argument expression must
  be side-effect free and the condition must never guard user input or I/O.
- Fail close to the cause: validate inputs at the public method boundary of
  a logic class and return early, rather than letting a bad value sink into
  the state and explode three ticks later.

## Minimal headless test entry point

Give logic classes a SceneTree test script the project can run in CI and
before commit:

```gdscript
# tests/run_tests.gd — run with:
#   godot --headless --path . -s res://tests/run_tests.gd
extends SceneTree

var _failures: int = 0

func _initialize() -> void:
    _test_delivery_scores_point()
    ...
    if _failures == 0:
        print("ALL TESTS PASSED")
    quit(1 if _failures > 0 else 0)

func _check(condition: bool, message: String) -> void:
    if not condition:
        _failures += 1
        push_error("FAIL: " + message)

func _test_delivery_scores_point() -> void:
    var model := BoardModel.new()
    model.setup(42)
    ...
    _check(model.score() == 1, "delivery increments score")
```

Exit code discipline (`quit(1)` on failure) is what lets scripts, CI, and
this skill's own verification loop consume the result.
