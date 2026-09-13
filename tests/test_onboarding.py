"""Tests comportementaux de l'onboarding et des transitions de wizard."""

from unittest.mock import patch


def test_should_show_onboarding_when_not_completed():
    with patch(
        "openagenticskyzer.app.components.onboarding._load_global_config",
        return_value={},
    ):
        from openagenticskyzer.app.components.onboarding import should_show_onboarding

        assert should_show_onboarding() is True


def test_should_hide_onboarding_after_completion():
    with patch(
        "openagenticskyzer.app.components.onboarding._load_global_config",
        return_value={"onboarding_done": True},
    ):
        from openagenticskyzer.app.components.onboarding import should_show_onboarding

        assert should_show_onboarding() is False


def test_next_step_updates_state_and_returns_target():
    from openagenticskyzer.app.components.onboarding import _next_step

    step = [1]
    assert _next_step(step, None, 3) == 3
    assert step == [3]


def test_finish_persists_completion_flag():
    from openagenticskyzer.app.components import onboarding

    cfg = {"theme": "dark"}
    saved = []

    with (
        patch.object(onboarding, "_load_global_config", return_value=cfg),
        patch.object(onboarding, "_save_global_config", side_effect=saved.append),
    ):
        onboarding._finish(None)

    assert saved == [{"theme": "dark", "onboarding_done": True}]


def test_dark_theme_contains_expected_variables():
    from openagenticskyzer.app.theme import get_theme_css

    css = get_theme_css("dark", "#3b82f6")
    assert "--bg: #0f172a;" in css
    assert "--surface: #1e293b;" in css
    assert "--accent: #3b82f6;" in css


def test_light_theme_has_light_background():
    from openagenticskyzer.app.theme import get_theme_css

    assert "--bg: #f8fafc;" in get_theme_css("light")


def test_unknown_theme_falls_back_to_dark():
    from openagenticskyzer.app.theme import get_theme_css

    assert "--bg: #0f172a;" in get_theme_css("unknown")


def test_invalid_accent_falls_back_to_default_without_css_injection():
    from openagenticskyzer.app.theme import get_theme_css

    css = get_theme_css("dark", "red; } body { display:none")
    assert "--accent: #3b82f6;" in css
    assert "display:none" not in css


def test_set_accent_normalizes_invalid_value_before_persisting():
    from openagenticskyzer.app.components import settings

    cfg = {}
    with patch.object(settings, "save_global_config") as save, patch.object(
        settings, "ui"
    ) as ui_mock, patch("openagenticskyzer.app.theme._apply_theme") as apply:
        settings._set_accent("#12zz34", cfg)

    assert cfg["accent_color"] == "#3b82f6"
    save.assert_called_once_with(cfg)
    apply.assert_called_once_with()
    ui_mock.notify.assert_not_called()
