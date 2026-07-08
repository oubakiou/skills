extends RefCounted

var waves = []
var gold = 0
var lives = 20

func setup():
	waves = []
	for i in range(5):
		var w = {}
		w["number"] = i + 1
		w["enemies"] = []
		var count = 3 + i * 2
		for j in range(count):
			var e = {}
			if j % 3 != 0:
				e["name"] = "slime"
			else:
				e["name"] = "orc"
			if e["name"] == "slime":
				e["hp"] = 8
				e["reward"] = 1
			else:
				e["hp"] = 20
				e["reward"] = 3
			w["enemies"].append(e)
		waves.append(w)
	gold = 10
	lives = 20

func run_wave(index, damage_per_enemy):
	if index < 0 or index >= waves.size():
		return null
	var w = waves[index]
	var killed = 0
	var leaked = 0
	for e in w["enemies"]:
		if damage_per_enemy >= e["hp"]:
			killed += 1
			gold += e["reward"]
		else:
			leaked += 1
			lives -= 1
	var result = {}
	result["killed"] = killed
	result["leaked"] = leaked
	result["gold"] = gold
	result["lives"] = lives
	return result
