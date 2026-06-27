#!/usr/bin/env python3
"""Launcher rapide pour l'app GUI — évite les imports agent/LLM."""
import sys
import os

# Désactiver les warnings inutiles
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"
import warnings
warnings.filterwarnings("ignore")

# Lancer l'app directement sans passer par agent.py
if __name__ == "__main__":
    from openagenticskyzer.app.main import main_app
    main_app()
