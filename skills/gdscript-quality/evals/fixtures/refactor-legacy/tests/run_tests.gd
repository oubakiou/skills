extends SceneTree

const WaveManager = preload("res://scripts/wave_manager.gd")

var _failures: int = 0

func _initialize() -> void:
	var manager := WaveManager.new()
	manager.setup()
	_check(manager.waves.size() == 5, "setup creates 5 waves")
	var first: Variant = manager.run_wave(0, 10)
	_check(first != null, "wave 0 returns a result")
	if first != null:
		var first_killed: int = first["killed"]
		var first_leaked: int = first["leaked"]
		_check(first_killed == 2 and first_leaked == 1, "wave 0 partial clear")
	_check(manager.gold == 12 and manager.lives == 19, "gold/lives after wave 0")
	var second: Variant = manager.run_wave(1, 25)
	_check(second != null, "wave 1 returns a result")
	if second != null:
		var second_killed: int = second["killed"]
		var second_leaked: int = second["leaked"]
		_check(second_killed == 5 and second_leaked == 0, "wave 1 full clear")
	_check(manager.gold == 21 and manager.lives == 19, "gold/lives after wave 1")
	_check(manager.run_wave(99, 5) == null, "invalid wave index returns null")
	manager.setup()
	_check(manager.gold == 10 and manager.lives == 20 and manager.waves.size() == 5, "setup resets state")
	if _failures == 0:
		print("ALL TESTS PASSED")
	quit(1 if _failures > 0 else 0)

func _check(condition: bool, message: String) -> void:
	if not condition:
		_failures += 1
		push_error("FAIL: " + message)
