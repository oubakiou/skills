extends Node2D

@onready var _hp_label: Label = $HpLabel

func _ready() -> void:
	_hp_label.text = "HP: -"
